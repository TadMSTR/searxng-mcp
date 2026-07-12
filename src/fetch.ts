import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import { FETCH_CACHE_TTL_SECONDS, WAYBACK_ENABLED } from "./config.js";
import {
  recordMetadataFetchAttempt,
  recordPostExtractSample,
  recordTierAttempt,
  type TierName,
} from "./domain-db.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";
import { events } from "./events.js";
import { postExtract } from "./extractors/post-extract.js";
import { assertPublicUrl, isPdfUrl, type TierResult } from "./fetch-utils.js";
import { histerFetch } from "./hister.js";
import { isKiwixHost, kiwixFetch } from "./kiwix.js";
import { tryLlmsTxtFetch } from "./llms-txt.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { checkRobots } from "./robots.js";
import { getTiers, TIER_NAME } from "./routing.js";
import {
  fetchRawHtmlForMetadata,
  githubFetch,
  isGithubUrl,
  tier2 as pdfTier,
  waybackFetch,
} from "./tiers/index.js";

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

    let result: TierResult;
    let tierServed = "github";
    if (isGithubUrl(url)) {
      // GitHub fast path — routed through runTier() so its hit/miss/error is
      // recorded in the domain-db and OTel like any other tier (SXNG-10).
      // githubFetch throws on failure; runTier catches it, records an error
      // attempt, and returns null, so we translate that back into a throw for
      // the caller.
      const gh = await runTier<TierResult | null>("github", url, () =>
        githubFetch(url, maxChars),
      );
      if (!gh) {
        events.error({
          stage: "fetch",
          url,
          error_type: "github_fetch_failed",
          message: "GitHub fast-path fetch failed",
        });
        throw new Error("GitHub fast-path fetch failed");
      }
      result = gh;
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

      // Kiwix fast path — intercepts Wikipedia, Stack Overflow, Arch Wiki
      // requests and serves from local Kiwix before the tier cascade.
      if (isKiwixHost(url)) {
        const kiwix = await withSpan("kiwix", { "fetch.url": url }, () =>
          kiwixFetch(url, 8000),
        );
        if (kiwix) {
          incCounter("fetch", { tier: "kiwix", outcome: "hit" });
          const persisted = {
            title: kiwix.title,
            url: kiwix.url,
            text: kiwix.text,
          };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "kiwix",
            title: kiwix.title,
            text_len: kiwix.text.length,
            latency_ms: Date.now() - t_total,
            source: "kiwix",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        // Kiwix miss (article not in ZIM or Kiwix down) — fall through to cascade
        incCounter("fetch", { tier: "kiwix", outcome: "miss" });
      }

      // Hister fast path — check Ted's browsing-history index before the tier
      // cascade. Serves pages that are login-walled or JS-heavy (already rendered
      // by Firefox) and avoids re-fetching stable docs that are indexed here.
      const hister = await withSpan("hister", { "fetch.url": url }, () =>
        histerFetch(url, 8000),
      );
      if (hister) {
        incCounter("fetch", { tier: "hister", outcome: "hit" });
        const persisted = {
          title: hister.title,
          url: hister.url,
          text: hister.text,
        };
        await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);
        events.fetchCompleted({
          url,
          tier_served: "hister",
          title: hister.title,
          text_len: hister.text.length,
          latency_ms: Date.now() - t_total,
          source: "hister",
        });
        return { ...persisted, text: persisted.text.slice(0, maxChars) };
      }
      incCounter("fetch", { tier: "hister", outcome: "miss" });

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
      const { active: activeTiers, skipped: skipDecisions } =
        await getTiers(url);
      // Announce all skipped tiers up front (metrics + events + logs).
      for (const { tier: slot, reason } of skipDecisions) {
        const tierName = TIER_NAME[slot];
        incCounter("fetch", { tier: tierName, outcome: "skipped" });
        events.fetchTierSkipped({ url, tier: tierName, reason });
        console.error(
          `[searxng-mcp] fetch ${slot} skipped url=${url} reason=${reason}`,
        );
      }

      // PDF fast path — Firecrawl can't extract PDF text; route directly to tier2.
      if (isPdfUrl(url)) {
        const pdfResult = await runTier("tier2_crawl4ai", url, () =>
          pdfTier.fetch(url, 8000, preferFit),
        );
        if (!pdfResult) {
          throw new Error(
            "PDF extraction requires Crawl4AI (CRAWL4AI_URL not configured)",
          );
        }
        const persisted = {
          title: pdfResult.title,
          url: pdfResult.url,
          text: pdfResult.text,
        };
        await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);
        events.fetchCompleted({
          url,
          tier_served: "tier2_crawl4ai",
          title: pdfResult.title,
          text_len: pdfResult.text.length,
          latency_ms: Date.now() - t_total,
        });
        return { ...persisted, text: persisted.text.slice(0, maxChars) };
      }

      // Run tier cascade and side-channel raw-HTML metadata fetch in parallel.
      const metadataHtmlPromise = fetchRawHtmlForMetadata(url);

      let fetched: TierResult | null = null;
      for (const tier of activeTiers) {
        fetched = await runTier(tier.name, url, () =>
          tier.fetch(url, 8000, preferFit),
        );
        if (fetched) {
          tierServed = tier.name;
          if (tier.slot !== "tier1") {
            console.error(`[searxng-mcp] fetch ${tier.slot} hit url=${url}`);
          }
          break;
        }
        console.error(`[searxng-mcp] fetch ${tier.slot} miss url=${url}`);
      }

      if (!fetched && WAYBACK_ENABLED) {
        console.error(`[searxng-mcp] fetch tier4_wayback attempt url=${url}`);
        fetched = await runTier("tier4_wayback", url, () =>
          waybackFetch(url, 8000),
        );
        if (fetched) {
          tierServed = "tier4_wayback";
          console.error(`[searxng-mcp] fetch tier4_wayback hit url=${url}`);
        } else {
          console.error(`[searxng-mcp] fetch tier4_wayback miss url=${url}`);
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
      recordMetadataFetchAttempt(url, metadataHtml !== null).catch(() => {});
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
