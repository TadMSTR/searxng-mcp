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
import { fetchPage } from "./fetch.js";
import { incCounter, recordHistogram } from "./observability.js";
import { checkRobots, getRobotsForOrigin } from "./robots.js";

export interface CrawlPage {
  url: string;
  title: string;
  snippet: string;
}

export interface CrawlManifest {
  strategy: "firecrawl" | "sitemap" | "bfs" | "error";
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

async function pollFirecrawlJob(
  jobId: string,
): Promise<FirecrawlPollResponse | null> {
  const deadline = Date.now() + FIRECRAWL_CRAWL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FIRECRAWL_CRAWL_POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${FIRECRAWL_URL}/v2/crawl/${jobId}`, {
        headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as FirecrawlPollResponse;
      if (body.status === "completed") return body;
      if (body.status === "failed" || body.status === "cancelled") return null;
    } catch {
      return null;
    }
  }
  return null; // timeout
}

export async function firecrawlCrawl(
  url: string,
  maxPages: number,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest | null> {
  if (!FIRECRAWL_URL) return null;
  try {
    const body: Record<string, unknown> = {
      url,
      limit: maxPages,
      scrapeOptions: { formats: ["markdown"] },
    };
    if (includePath) body.includePaths = [includePath];
    if (excludePath) body.excludePaths = [excludePath];

    const startRes = await fetch(`${FIRECRAWL_URL}/v2/crawl`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!startRes.ok) return null;
    const startJson = (await startRes.json()) as {
      success?: boolean;
      id?: string;
    };
    if (!startJson.success || !startJson.id) return null;

    const poll = await pollFirecrawlJob(startJson.id);
    if (!poll?.data) return null;

    const pages: CrawlPage[] = [];
    for (const page of poll.data) {
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

    return {
      strategy: "firecrawl",
      base_url: url,
      page_count: pages.length,
      pages,
      cached: false,
    };
  } catch {
    return null;
  }
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
    const res = await fetch(url, {
      headers: { "User-Agent": "searxng-mcp" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.text();
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
      // extraction. fetchPage already cached the content; we need HTML for links.
      const rawRes = await fetch(normalizedUrl, {
        headers: { "User-Agent": "searxng-mcp" },
        signal: AbortSignal.timeout(10_000),
      });
      if (rawRes.ok) rawHtml = await rawRes.text();
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
        `| ${i + 1} | ${p.url} | ${p.title.replace(/\|/g, "\\|")} | ${p.snippet.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");

  const footer =
    "\n\nFull content cached. Use fetch_url on any URL above for complete text.";

  return `${header}${note}${tableHeader}${rows}${footer}`;
}
