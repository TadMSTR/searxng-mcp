import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import {
  CRAWL_BFS_ENABLED,
  CRAWL_BFS_MAX_DEPTH,
  CRAWL_MANIFEST_TTL_SECONDS,
  FETCH_CACHE_TTL_SECONDS,
  FIRECRAWL_API_KEY,
  FIRECRAWL_CRAWL_MAX_WAIT_MS,
  FIRECRAWL_CRAWL_POLL_INTERVAL_MS,
  FIRECRAWL_URL,
} from "./config.js";
import { recordTierAttempt } from "./domain-db.js";
import { assertPublicUrl, fetchPage } from "./fetch.js";
import { readBoundedText, safeFetch } from "./fetch-utils.js";
import { firecrawlEndpoint, firecrawlSupportsMap } from "./firecrawl-api.js";
import { logWarn } from "./log.js";
import { incCounter, recordHistogram } from "./observability.js";
import { checkRobots, getRobotsForOrigin } from "./robots.js";
import { assertResolvedPublic } from "./ssrf-guard.js";

export interface CrawlPage {
  url: string;
  title: string;
  snippet: string;
}

export interface CrawlManifest {
  strategy: "firecrawl" | "map" | "sitemap" | "bfs" | "error";
  base_url: string;
  page_count: number;
  pages: CrawlPage[];
  cached: boolean;
  note?: string;
}

function crawlManifestCacheKey(
  url: string,
  maxPages: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
): string {
  const raw = `${url}|${maxPages}|${sameDomainOnly}|${includePath ?? ""}|${excludePath ?? ""}`;
  return `crawl:${createHash("sha256").update(raw).digest("hex")}`;
}

function makeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ─── Phase 1: Firecrawl ──────────────────────────────────────────────────────

interface FirecrawlPage {
  markdown?: string;
  metadata?: { title?: string; sourceURL?: string };
}

interface FirecrawlPollResponse {
  status: string;
  total?: number;
  completed?: number;
  data?: FirecrawlPage[];
}

/**
 * Record a Firecrawl crawl-phase outcome.
 *
 * The whole point of Phase 5 of this build. Every failure below used to be a
 * bare `return null` into `crawlSite`'s fallback chain, so `crawl_site` kept
 * returning healthy-looking manifests from the sitemap path while the Firecrawl
 * phase 404'd on literally every call for the life of the feature (vikunja#644).
 * A non-2xx is now logged and counted with a typed reason, and lands in
 * `domain_stats` under the `crawl` slot — so "this phase never succeeds" is
 * answerable without a live probe.
 */
function recordCrawlOutcome(
  url: string,
  outcome: "hit" | "miss",
  reason?: string,
): void {
  if (outcome === "miss") {
    logWarn(`crawl_site firecrawl phase miss: ${reason} url=${url}`);
  }
  incCounter("crawl", { strategy: "firecrawl", outcome });
  recordTierAttempt(url, "crawl_firecrawl", outcome, reason).catch(() => {});
}

async function pollFirecrawlJob(
  jobId: string,
): Promise<{ body: FirecrawlPollResponse } | { error: string }> {
  const deadline = Date.now() + FIRECRAWL_CRAWL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FIRECRAWL_CRAWL_POLL_INTERVAL_MS));
    try {
      const res = await fetch(firecrawlEndpoint(`crawl/${jobId}`), {
        headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { error: `poll ${res.status}` };
      // Bounded read before JSON.parse — consistent with the rest of the
      // fetch layer. Firecrawl is first-party, so this is uniformity rather
      // than a threat, but res.json() is unbounded either way.
      const body = JSON.parse(
        await readBoundedText(res),
      ) as FirecrawlPollResponse;
      if (body.status === "completed") return { body };
      if (body.status === "failed" || body.status === "cancelled") {
        return { error: `job ${body.status}` };
      }
    } catch (err) {
      return {
        error: `poll error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { error: "poll timeout" };
}

export async function firecrawlCrawl(
  url: string,
  maxPages: number,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest | null> {
  if (!FIRECRAWL_URL) return null;

  let startRes: Response;
  try {
    const body: Record<string, unknown> = {
      url,
      limit: maxPages,
      scrapeOptions: { formats: ["markdown"] },
    };
    if (includePath) body.includePaths = [includePath];
    if (excludePath) body.excludePaths = [excludePath];

    // Versioned via firecrawlEndpoint rather than a hardcoded prefix. This line
    // read `/v2/crawl` against a v1-only backend for the life of the feature.
    startRes = await fetch(firecrawlEndpoint("crawl"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    recordCrawlOutcome(
      url,
      "miss",
      `start error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  try {
    if (!startRes.ok) {
      recordCrawlOutcome(url, "miss", `start ${startRes.status}`);
      return null;
    }
    const startJson = (await startRes.json()) as {
      success?: boolean;
      id?: string;
    };
    if (!startJson.success || !startJson.id) {
      recordCrawlOutcome(url, "miss", "start returned no job id");
      return null;
    }
    // Validate job ID before interpolating into URL path (F-03)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(startJson.id)) {
      recordCrawlOutcome(url, "miss", "malformed job id");
      return null;
    }

    const poll = await pollFirecrawlJob(startJson.id);
    if ("error" in poll) {
      recordCrawlOutcome(url, "miss", poll.error);
      return null;
    }
    if (!poll.body.data) {
      recordCrawlOutcome(url, "miss", "completed with no data");
      return null;
    }

    const pages: CrawlPage[] = [];
    for (const page of poll.body.data) {
      const pageUrl = page.metadata?.sourceURL;
      if (!pageUrl) continue;
      const title = page.metadata?.title ?? pageUrl;
      const text = page.markdown ?? "";
      const snippet = makeSnippet(text);

      // Cache full content under fetch: key
      const fetchKey = fetchCacheKey(pageUrl);
      await cacheSet(
        fetchKey,
        JSON.stringify({ title, url: pageUrl, text }),
        FETCH_CACHE_TTL_SECONDS,
      );
      pages.push({ url: pageUrl, title, snippet });
    }

    recordCrawlOutcome(url, "hit");
    return {
      strategy: "firecrawl",
      base_url: url,
      page_count: pages.length,
      pages,
      cached: false,
    };
  } catch (err) {
    recordCrawlOutcome(
      url,
      "miss",
      `crawl error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ─── Phase 1b: /map (v2 only) ────────────────────────────────────────────────

interface FirecrawlMapResponse {
  success?: boolean;
  links?: Array<string | { url?: string; title?: string }>;
}

/**
 * Normalise `/map`'s `links` array to plain URLs.
 *
 * Tolerant of both shapes on purpose: firecrawl 2.11.162 returns a bare array
 * whose element type is not pinned by the self-host docs, and the migration
 * plan assumed `{url, title}` objects. Rather than code to one and discover the
 * other in production — which is the same class of mistake as the hardcoded
 * `/v2` prefix — accept either and drop anything that is neither.
 */
export function extractMapUrls(body: FirecrawlMapResponse): string[] {
  if (!Array.isArray(body.links)) return [];
  const out: string[] = [];
  for (const link of body.links) {
    const raw = typeof link === "string" ? link : link?.url;
    if (typeof raw === "string" && raw.startsWith("http")) out.push(raw);
  }
  return out;
}

/**
 * Ask Firecrawl for a site's URLs. Purpose-built for exactly what the sitemap
 * phase hand-rolls, and it handles sites whose sitemap is absent, stale or
 * split across nested indexes. v2 only — the legacy backend has no map
 * endpoint, so `crawlSite` skips this phase rather than probing and 404ing.
 */
export async function firecrawlMapUrls(url: string): Promise<string[] | null> {
  if (!FIRECRAWL_URL || !firecrawlSupportsMap()) return null;
  try {
    const res = await fetch(firecrawlEndpoint("map"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Counted and logged for the same reason the crawl start is: a silent
      // non-2xx here would put us straight back in #644.
      logWarn(`crawl_site map phase miss: map ${res.status} url=${url}`);
      incCounter("crawl", { strategy: "map", outcome: "miss" });
      return null;
    }
    const body = JSON.parse(await readBoundedText(res)) as FirecrawlMapResponse;
    const urls = extractMapUrls(body);
    if (urls.length === 0) {
      logWarn(`crawl_site map phase miss: map returned no links url=${url}`);
      incCounter("crawl", { strategy: "map", outcome: "miss" });
      return null;
    }
    return urls;
  } catch (err) {
    logWarn(
      `crawl_site map phase miss: ${err instanceof Error ? err.message : String(err)} url=${url}`,
    );
    incCounter("crawl", { strategy: "map", outcome: "miss" });
    return null;
  }
}

export async function mapCrawl(
  url: string,
  maxPages: number,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest | null> {
  let urls = await firecrawlMapUrls(url);
  if (!urls || urls.length === 0) return null;

  if (includePath) urls = urls.filter((u) => u.includes(includePath));
  if (excludePath) urls = urls.filter((u) => !u.includes(excludePath));
  if (urls.length === 0) return null;

  const pages = await batchFetch(urls, maxPages);
  return {
    strategy: "map",
    base_url: url,
    page_count: pages.length,
    pages,
    cached: false,
  };
}

// ─── Phase 2: Sitemap-first ──────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ["url", "sitemap"].includes(name),
});

export function extractSitemapUrls(xml: string): string[] {
  try {
    const result = xmlParser.parse(xml) as Record<string, unknown>;
    const urlset = result.urlset as
      | { url?: Array<{ loc?: unknown }> }
      | undefined;
    if (urlset?.url) {
      return urlset.url
        .map((u) => String(u.loc ?? ""))
        .filter((loc) => loc.startsWith("http"));
    }
    const idx = result.sitemapindex as
      | { sitemap?: Array<{ loc?: unknown }> }
      | undefined;
    if (idx?.sitemap) {
      return idx.sitemap
        .map((s) => String(s.loc ?? ""))
        .filter((loc) => loc.startsWith("http"));
    }
  } catch {
    // malformed XML — return empty
  }
  return [];
}

async function fetchSitemapXml(url: string): Promise<string | null> {
  try {
    // SSRF guard — sitemap URLs can come from untrusted robots.txt. safeFetch
    // applies the string check and the DNS-validating dispatcher (each redirect
    // hop included).
    const res = await safeFetch(url, {
      headers: { "User-Agent": "searxng-mcp" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await readBoundedText(res); // bounded read — prevents oversized sitemap DoS (F-02)
  } catch {
    return null;
  }
}

export async function discoverSitemapUrls(
  origin: string,
  maxDepth = 3,
): Promise<string[]> {
  const candidates: string[] = [];
  const allUrls = new Set<string>();

  // Try robots.txt Sitemap: directives first
  try {
    const robots = await getRobotsForOrigin(origin);
    if (robots.body) {
      const sitemapLines = robots.body
        .split("\n")
        .filter((l) => l.toLowerCase().startsWith("sitemap:"))
        .map((l) => l.split(":").slice(1).join(":").trim());
      candidates.push(...sitemapLines);
    }
  } catch {
    // continue
  }

  // Well-known paths as fallback
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  async function processSitemap(url: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const xml = await fetchSitemapXml(url);
    if (!xml) return;
    const locs = extractSitemapUrls(xml);
    for (const loc of locs) {
      if (loc.endsWith(".xml")) {
        // Child sitemap — recurse
        if (!allUrls.has(loc)) {
          allUrls.add(loc);
          await processSitemap(loc, depth + 1);
        }
      } else {
        allUrls.add(loc);
      }
    }
  }

  for (const candidate of candidates) {
    if (!allUrls.has(candidate)) {
      await processSitemap(candidate, 0);
      if (allUrls.size > 0) break; // first hit wins
    }
  }

  return Array.from(allUrls).filter((u) => !u.endsWith(".xml"));
}

async function batchFetch(
  urls: string[],
  maxPages: number,
  concurrency = 5,
): Promise<CrawlPage[]> {
  const sliced = urls.slice(0, maxPages);
  const pages: CrawlPage[] = [];

  for (let i = 0; i < sliced.length; i += concurrency) {
    const chunk = sliced.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (url) => {
        const robots = await checkRobots(url, "searxng-mcp");
        if (!robots.allowed) return null;
        const { title, text } = await fetchPage(url, 8000);
        const snippet = makeSnippet(text);
        return { url, title, snippet };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) pages.push(r.value);
    }
  }
  return pages;
}

export async function sitemapCrawl(
  url: string,
  maxPages: number,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest | null> {
  try {
    const origin = new URL(url).origin;
    let urls = await discoverSitemapUrls(origin);
    if (urls.length === 0) return null;

    if (includePath) urls = urls.filter((u) => u.includes(includePath));
    if (excludePath) urls = urls.filter((u) => !u.includes(excludePath));
    if (urls.length === 0) return null;

    const pages = await batchFetch(urls, maxPages);
    return {
      strategy: "sitemap",
      base_url: url,
      page_count: pages.length,
      pages,
      cached: false,
    };
  } catch {
    return null;
  }
}

// ─── Phase 3: BFS ────────────────────────────────────────────────────────────

export async function bfsCrawl(
  startUrl: string,
  maxPages: number,
  maxDepth: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest> {
  const startHost = new URL(startUrl).hostname;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: startUrl, depth: 0 },
  ];
  const pages: CrawlPage[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const item = queue.shift();
    if (!item) break;
    const normalizedUrl = item.url.split("#")[0]; // strip fragment
    if (visited.has(normalizedUrl)) continue;
    if (item.depth > maxDepth) continue;

    const robots = await checkRobots(normalizedUrl, "searxng-mcp");
    if (!robots.allowed) continue;

    visited.add(normalizedUrl);

    let fetchedTitle = normalizedUrl;
    let fetchedText = "";
    let rawHtml = "";

    try {
      const result = await fetchPage(normalizedUrl, 8000);
      fetchedTitle = result.title;
      fetchedText = result.text;

      // Extract links from the raw response — re-fetch with raw tier for link
      // extraction. fetchPage already cached the content; we need HTML for
      // links. safeFetch guards this attacker-influenced URL (BFS discovers it
      // from a crawled page) against private/reserved resolutions.
      const rawRes = await safeFetch(normalizedUrl, {
        headers: { "User-Agent": "searxng-mcp" },
        signal: AbortSignal.timeout(10_000),
      });
      if (rawRes.ok) rawHtml = await readBoundedText(rawRes); // bounded read — prevents oversized HTML DoS (F-02)
    } catch {
      continue;
    }

    pages.push({
      url: normalizedUrl,
      title: fetchedTitle,
      snippet: makeSnippet(fetchedText),
    });

    // Extract links via JSDOM (already a dep)
    if (rawHtml && item.depth < maxDepth) {
      try {
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(rawHtml, { url: normalizedUrl });
        const anchors = dom.window.document.querySelectorAll("a[href]");
        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).href;
          if (!href.startsWith("http")) continue;
          const normalized = href.split("#")[0];
          if (visited.has(normalized)) continue;

          const parsed = new URL(normalized);
          if (sameDomainOnly && parsed.hostname !== startHost) continue;
          if (includePath && !parsed.pathname.includes(includePath)) continue;
          if (excludePath && parsed.pathname.includes(excludePath)) continue;

          queue.push({ url: normalized, depth: item.depth + 1 });
        }
      } catch {
        // JSDOM unavailable or parse error — skip link extraction
      }
    }
  }

  return {
    strategy: "bfs",
    base_url: startUrl,
    page_count: pages.length,
    pages,
    cached: false,
    note: `BFS depth limited to ${maxDepth}`,
  };
}

// ─── Strategy cascade ────────────────────────────────────────────────────────

export async function crawlSite(
  url: string,
  maxPages: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest> {
  assertPublicUrl(url); // SSRF guard — validate before any strategy dispatch (F-01)
  // Firecrawl (phase 1) resolves and fetches the target itself, so pre-resolve
  // the hostname here to reject a DNS-rebind to an internal address before the
  // URL is handed off (parity with fetchPage's tier1/tier2 guard).
  await assertResolvedPublic(url);
  const t0 = Date.now();
  const cacheKey = crawlManifestCacheKey(
    url,
    maxPages,
    sameDomainOnly,
    includePath,
    excludePath,
  );

  // Check manifest cache
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      // SECURITY[accepted]: JSON.parse without schema validation. Cache is written only by
      // crawlSite itself from trusted crawl results. Corrupt entries fall through to a live
      // crawl via the catch block. Auditor confirmed no action required. Audit: 2026-06-05/searxng-mcp-crawl-2026-06.
      const manifest = JSON.parse(cached) as CrawlManifest;
      incCounter("crawl", {
        strategy: manifest.strategy,
        outcome: "manifest_hit",
      });
      return { ...manifest, cached: true };
    } catch {
      // corrupt cache — fall through
    }
  }

  let manifest: CrawlManifest | null = null;

  // Phase 1: Firecrawl
  if (FIRECRAWL_URL) {
    manifest = await firecrawlCrawl(url, maxPages, includePath, excludePath);
    if (manifest) {
      incCounter("crawl", { strategy: "firecrawl", outcome: "success" });
    }
  }

  // Phase 1b: /map — v2 only. Ahead of the hand-rolled sitemap parse because it
  // is purpose-built for the same job and copes with sites whose sitemap is
  // absent, stale or split across nested indexes. Under v1 firecrawlMapUrls
  // short-circuits, so this costs a predicate and no request.
  if (!manifest && FIRECRAWL_URL && firecrawlSupportsMap()) {
    manifest = await mapCrawl(url, maxPages, includePath, excludePath);
    if (manifest) {
      incCounter("crawl", { strategy: "map", outcome: "fallback_map" });
    }
  }

  // Phase 2: Sitemap
  if (!manifest) {
    manifest = await sitemapCrawl(url, maxPages, includePath, excludePath);
    if (manifest) {
      incCounter("crawl", { strategy: "sitemap", outcome: "fallback_sitemap" });
    }
  }

  // Phase 3: BFS (opt-in)
  if (!manifest && CRAWL_BFS_ENABLED) {
    manifest = await bfsCrawl(
      url,
      maxPages,
      CRAWL_BFS_MAX_DEPTH,
      sameDomainOnly,
      includePath,
      excludePath,
    );
    if (manifest) {
      incCounter("crawl", { strategy: "bfs", outcome: "fallback_bfs" });
    }
  }

  if (!manifest) {
    incCounter("crawl", { strategy: "none", outcome: "error" });
    return {
      strategy: "error",
      base_url: url,
      page_count: 0,
      pages: [],
      cached: false,
      note: "All crawl strategies failed. No sitemap found and BFS is disabled.",
    };
  }

  // Cache the manifest
  await cacheSet(
    cacheKey,
    JSON.stringify(manifest),
    CRAWL_MANIFEST_TTL_SECONDS,
  );

  const durationSeconds = (Date.now() - t0) / 1000;
  recordHistogram("crawl", durationSeconds, { strategy: manifest.strategy });

  return manifest;
}

// ─── Format output ───────────────────────────────────────────────────────────

export function formatCrawlManifest(manifest: CrawlManifest): string {
  if (manifest.strategy === "error") {
    return `Crawl failed: ${manifest.note ?? "Unknown error"}`;
  }

  const header = `Strategy: ${manifest.strategy} | base: ${manifest.base_url} | ${manifest.page_count} pages${manifest.cached ? " (cached)" : ""}`;
  const note = manifest.note ? `\n${manifest.note}` : "";

  if (manifest.pages.length === 0) {
    return `${header}${note}\n\nNo pages found.`;
  }

  const tableHeader = `\n\n| # | URL | Title | Snippet |\n|---|-----|-------|---------|\n`;
  const rows = manifest.pages
    .map(
      (p, i) =>
        `| ${i + 1} | ${p.url.replace(/\|/g, "\\|")} | ${p.title.replace(/\|/g, "\\|")} | ${p.snippet.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");

  const footer =
    "\n\nFull content cached. Use fetch_url on any URL above for complete text.";

  return `${header}${note}${tableHeader}${rows}${footer}`;
}
