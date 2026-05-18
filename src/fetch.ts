import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import { FETCH_CACHE_TTL_SECONDS } from "./config.js";
import {
  recordPostExtractSample,
  recordTierAttempt,
  type TierName,
} from "./domain-db.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";
import { events } from "./events.js";
import { postExtract } from "./extractors/post-extract.js";
import { assertPublicUrl, type TierResult } from "./fetch-utils.js";
import { tryLlmsTxtFetch } from "./llms-txt.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { checkRobots } from "./robots.js";
import { computeTierSkips, type SkipReason, TIER_NAME } from "./routing.js";
import {
  applyTier2Readability,
  crawl4aiFetch,
  fetchRawHtmlForMetadata,
  firecrawlScrape,
  githubFetch,
  rawFetch,
} from "./tiers/index.js";
import type { TierSlot } from "./types.js";

// Re-export for callers that import assertPublicUrl from this module.
export { assertPublicUrl } from "./fetch-utils.js";

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows fetch: ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

// Re-export rawFetch for external callers (e.g. tests).
export { rawFetch } from "./tiers/index.js";

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
