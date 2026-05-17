import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import {
  CRAWL4AI_API_TOKEN,
  CRAWL4AI_URL,
  FETCH_CACHE_TTL_SECONDS,
  FIRECRAWL_API_KEY,
  FIRECRAWL_URL,
  GITHUB_TOKEN,
} from "./config.js";
import {
  recordPostExtractSample,
  recordTierAttempt,
  type TierName,
} from "./domain-db.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";
import { events } from "./events.js";
import { postExtract } from "./extractors/post-extract.js";
import { preferReadability, runReadability } from "./extractors/readability.js";
import { tryLlmsTxtFetch } from "./llms-txt.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { checkRobots } from "./robots.js";
import { computeTierSkips, type SkipReason, TIER_NAME } from "./routing.js";
import type {
  FirecrawlScrapeResponse,
  GitHubReadmeResponse,
  TierSlot,
} from "./types.js";

export const USER_AGENT =
  "searxng-mcp/3.5.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)";

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows fetch: ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

interface TierResult {
  title: string;
  url: string;
  text: string;
  html?: string;
}

export function assertPublicUrl(url: string): void {
  const { protocol } = new URL(url);
  // Strip IPv6 brackets so patterns like /^::1$/ match [::1] addresses correctly
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!/^https?:$/.test(protocol)) {
    throw new Error(`Only http/https URLs are supported`);
  }
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^host\.docker\.internal$/i,
    /^fc[0-9a-f]{2}:/i,
    /^fe[89ab][0-9a-f]:/i,
    /^::1$/,
    /^0:0:0:0:0:0:0:1$/,
    /^fd[0-9a-f]{2}:/i,
  ];
  if (blocked.some((r) => r.test(hostname))) {
    throw new Error(`Internal/private addresses are not allowed`);
  }
}

async function githubFetch(
  url: string,
  maxChars = 8000,
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo] or [owner, repo, "blob"|"tree", branch, ...path]

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const [owner, repo, , branch, ...filePath] = parts;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    const rawHeaders: Record<string, string> = { "User-Agent": USER_AGENT };
    if (GITHUB_TOKEN) rawHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(rawUrl, {
      headers: rawHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
      throw new Error(
        `GitHub raw fetch error: ${res.status} ${res.statusText}`,
      );
    const text = (await res.text()).slice(0, maxChars);
    const fileName = filePath[filePath.length - 1] ?? url;
    return { title: fileName, url: rawUrl, text };
  }

  // Repo root or tree — fetch README via GitHub API
  const [owner, repo] = parts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64")
    .toString("utf-8")
    .slice(0, maxChars);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}

async function firecrawlScrape(
  url: string,
  maxChars = 8000,
): Promise<TierResult> {
  const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ url, formats: ["markdown", "html"] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Firecrawl error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    throw new Error(data.error ?? "Firecrawl returned no data");
  }

  const title = data.data.metadata?.title ?? url;
  const text = (data.data.markdown ?? "").slice(0, maxChars);
  const html = data.data.html;

  return { title, url: data.data.metadata?.sourceURL ?? url, text, html };
}

async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  maxChars: number,
  signal: AbortSignal,
  preferFit = false,
): Promise<TierResult | null> {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (signal.aborted) return null;

    try {
      const resp = await fetch(`${CRAWL4AI_URL}/task/${taskId}`, { signal });
      if (!resp.ok) return null;

      const data = (await resp.json()) as Record<string, unknown>;
      if (data.status === "completed") {
        const result = data.result as Record<string, unknown> | null;
        const md = result?.markdown as Record<string, string> | null;
        const mdRaw = preferFit
          ? md?.fit_markdown || md?.raw_markdown
          : md?.raw_markdown || md?.fit_markdown;
        const text = (mdRaw ?? "").slice(0, maxChars);
        const metadata = result?.metadata as Record<string, string> | null;
        const title = metadata?.title || url;
        const html =
          typeof result?.html === "string"
            ? (result.html as string)
            : undefined;
        return text ? { title, url, text, html } : null;
      }
      if (data.status === "failed") return null;
    } catch {
      return null;
    }
  }

  return null;
}

async function crawl4aiFetch(
  url: string,
  maxChars = 8000,
  preferFit = false,
): Promise<TierResult | null> {
  if (!CRAWL4AI_URL) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const crawlHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CRAWL4AI_API_TOKEN)
      crawlHeaders.Authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      body: JSON.stringify({ urls: [url] }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;

    // Synchronous response — results returned directly
    if (Array.isArray(data.results) && data.results.length > 0) {
      const result = data.results[0] as Record<string, unknown>;
      const md = result.markdown as Record<string, string> | null;
      const mdRaw = preferFit
        ? md?.fit_markdown || md?.raw_markdown
        : md?.raw_markdown || md?.fit_markdown;
      const text = (mdRaw ?? "").slice(0, maxChars);
      if (!text) return null;
      const metadata = result.metadata as Record<string, string> | null;
      const title = metadata?.title || url;
      const html =
        typeof result.html === "string" ? (result.html as string) : undefined;
      return { title, url, text, html };
    }

    // Asynchronous response — poll for completion
    if (typeof data.task_id === "string") {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) return null;
      return await pollCrawl4aiTask(
        data.task_id,
        url,
        maxChars,
        controller.signal,
        preferFit,
      );
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function rawFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `Redirect blocked: ${res.status} → ${res.headers.get("location")}`,
    );
  }
  if (!res.ok)
    throw new Error(`Raw fetch error: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const dom = new JSDOM(html, { url }); // runScripts not set — script execution disabled
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text = (article?.textContent ?? html).slice(0, maxChars);
  const title = article?.title ?? url;
  return { title, url, text, html };
}

function applyTier2Readability(fetched: TierResult, url: string): TierResult {
  if (!fetched.html) return fetched;
  const readable = runReadability(fetched.html, url);
  if (preferReadability(readable, fetched) && readable) {
    return {
      ...fetched,
      title: readable.title ?? fetched.title,
      text: readable.text,
    };
  }
  return fetched;
}

async function fetchRawHtmlForMetadata(url: string): Promise<string | null> {
  // Raw HTTP fetch (no JS rendering) used as the source for JSON-LD and meta
  // tags. Tier 1/2 puppeteer renders inject payment-widget og:title tags and
  // can strip JSON-LD scripts; the unrendered HTML is more reliable for
  // post-extraction.
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function applyPostExtract(
  fetched: TierResult,
  url: string,
  metadataHtml: string | null,
): TierResult {
  const html = metadataHtml ?? fetched.html ?? null;
  if (!html) return fetched;
  const enriched = postExtract({
    url,
    html,
    baselineTitle: fetched.title,
    baselineText: fetched.text,
    maxChars: 8000,
  });

  // Sample what we saw in the metadata HTML for the domain DB. Cheap regex
  // checks — full extraction is already done inside postExtract.
  const jsonLdPresent = enriched.source === "json_ld";
  const ogTitlePresent =
    /<meta[^>]+(property|name)\s*=\s*["']og:title["']/i.test(html);
  recordPostExtractSample(url, { jsonLdPresent, ogTitlePresent }).catch(
    () => {},
  );

  return {
    ...fetched,
    title: enriched.title,
    text: enriched.text,
  };
}

async function runTier<T extends TierResult | null>(
  tier: TierName,
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await withSpan(tier, { "fetch.url": url }, () => fn());
    const latency_ms = Date.now() - t0;
    if (out) {
      incCounter("fetch", { tier, outcome: "hit" });
      recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "hit" });
      recordTierAttempt(url, tier, "hit").catch(() => {});
    } else {
      incCounter("fetch", { tier, outcome: "miss" });
      recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "miss" });
      events.fetchTierMiss({ url, tier, reason: "empty_result", latency_ms });
      recordTierAttempt(url, tier, "miss", "empty_result").catch(() => {});
    }
    return out;
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const reason = err instanceof Error ? err.message : "error";
    incCounter("fetch", { tier, outcome: "error" });
    recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "error" });
    events.fetchTierMiss({ url, tier, reason, latency_ms });
    recordTierAttempt(url, tier, "error", reason).catch(() => {});
    return null as T;
  }
}

export async function fetchPage(
  url: string,
  maxChars = 8000,
  domainProfile?: string,
  preferFit = false,
): Promise<{ title: string; url: string; text: string }> {
  return withSpan("fetch", { "fetch.url": url }, async () => {
    const t_total = Date.now();
    assertPublicUrl(url);
    events.fetchRequested({ url, max_chars: maxChars, prefer_fit: preferFit });

    // Refuse to fetch blocked domains
    const blockList = getBlockList(domainProfile);
    if (blockList.some((pat) => urlMatchesDomain(url, pat))) {
      events.error({
        stage: "fetch",
        url,
        error_type: "blocked_domain",
        message: "Domain is blocked by domain filter configuration",
      });
      throw new Error(`Domain is blocked by domain filter configuration`);
    }

    // Check fetch cache — always stored at 8000 chars, sliced to maxChars on read
    const key = fetchCacheKey(url);
    const cached = await cacheGet(key);
    if (cached) {
      try {
        const r = JSON.parse(cached) as {
          title: string;
          url: string;
          text: string;
        };
        events.fetchCompleted({
          url,
          tier_served: "cache",
          title: r.title,
          text_len: r.text.length,
          latency_ms: Date.now() - t_total,
        });
        return { ...r, text: r.text.slice(0, maxChars) };
      } catch {
        // Corrupted cache entry — fall through to live fetch
      }
    }

    const { hostname } = new URL(url);

    let result: TierResult;
    let tierServed = "github";
    if (hostname === "github.com") {
      result = await githubFetch(url, maxChars);
    } else {
      // llms.txt fast path — for whitelisted docs domains, try fetching the
      // section from a pre-cached llms-full.txt before invoking any tier.
      const llms = await withSpan("llms_full_txt", { "fetch.url": url }, () =>
        tryLlmsTxtFetch(url, 8000),
      );
      if (llms) {
        incCounter("fetch", { tier: "llms_full_txt", outcome: "hit" });
        const persisted = {
          title: llms.title,
          url: llms.url,
          text: llms.text,
        };
        await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);
        events.fetchCompleted({
          url,
          tier_served: "llms_full_txt",
          title: llms.title,
          text_len: llms.text.length,
          latency_ms: Date.now() - t_total,
          source: "llms_full_txt",
        });
        return { ...persisted, text: persisted.text.slice(0, maxChars) };
      }

      // robots.txt gate — skips fetch on disallow (cached 24h per origin)
      const robots = await checkRobots(url, "searxng-mcp");
      if (!robots.allowed) {
        console.error(
          `[searxng-mcp] fetch skipped_robots url=${url} reason=${robots.reason ?? "disallowed"}`,
        );
        incCounter("fetch", { tier: "robots", outcome: "skipped_robots" });
        events.fetchTierSkipped({
          url,
          tier: "robots",
          reason: robots.reason ?? "disallowed",
        });
        throw new RobotsDisallowedError(url);
      }

      // Resolve data-driven + operator skips before kicking off the cascade.
      const skipDecisions = await computeTierSkips(url);
      const skipBy = new Map<TierSlot, SkipReason>(
        skipDecisions.map((d) => [d.tier, d.reason]),
      );
      const announceSkip = (slot: TierSlot): void => {
        const reason = skipBy.get(slot);
        if (!reason) return;
        const tierName = TIER_NAME[slot];
        incCounter("fetch", { tier: tierName, outcome: "skipped" });
        events.fetchTierSkipped({ url, tier: tierName, reason });
        console.error(
          `[searxng-mcp] fetch ${slot} skipped url=${url} reason=${reason}`,
        );
      };

      // Run tier cascade and side-channel raw-HTML metadata fetch in parallel.
      const metadataHtmlPromise = fetchRawHtmlForMetadata(url);

      let fetched: TierResult | null = null;
      if (skipBy.has("tier1")) {
        announceSkip("tier1");
      } else {
        fetched = await runTier("tier1_firecrawl", url, async () => {
          const r = await firecrawlScrape(url, 8000);
          return r?.text ? r : null;
        });
        if (fetched) {
          tierServed = "tier1_firecrawl";
        } else {
          console.error(`[searxng-mcp] fetch tier1 miss url=${url}`);
        }
      }

      if (!fetched) {
        if (skipBy.has("tier2")) {
          announceSkip("tier2");
        } else {
          fetched = await runTier("tier2_crawl4ai", url, () =>
            crawl4aiFetch(url, 8000, preferFit),
          );
          if (fetched) {
            fetched = applyTier2Readability(fetched, url);
            tierServed = "tier2_crawl4ai";
            console.error(`[searxng-mcp] fetch tier2 hit url=${url}`);
          } else {
            console.error(`[searxng-mcp] fetch tier2 miss url=${url}`);
          }
        }
      }

      if (!fetched) {
        if (skipBy.has("tier3")) {
          announceSkip("tier3");
        } else {
          console.error(`[searxng-mcp] fetch tier3 fallback url=${url}`);
          fetched = await runTier("tier3_rawfetch", url, () =>
            rawFetch(url, 8000),
          );
          if (fetched) tierServed = "tier3_rawfetch";
        }
      }

      if (!fetched) {
        events.error({
          stage: "fetch",
          url,
          error_type: "all_tiers_failed",
          message: "All fetch tiers failed",
        });
        throw new Error("All fetch tiers failed");
      }

      const tierFetched: TierResult = fetched;
      const metadataHtml = await metadataHtmlPromise;
      result = await withSpan("post_extract", { "fetch.url": url }, () =>
        applyPostExtract(tierFetched, url, metadataHtml),
      );
    }

    // Strip html from cache payload — only the resolved title/text/url are persisted
    const persisted = {
      title: result.title,
      url: result.url,
      text: result.text,
    };
    await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);

    events.fetchCompleted({
      url,
      tier_served: tierServed,
      title: result.title,
      text_len: result.text.length,
      latency_ms: Date.now() - t_total,
    });

    return { ...persisted, text: persisted.text.slice(0, maxChars) };
  });
}
