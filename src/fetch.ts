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
import {
  assertPublicUrl,
  type FetchTuning,
  isPdfUrl,
  type TierResult,
} from "./fetch-utils.js";
import { histerFetch } from "./hister.js";
import { isKiwixHost, kiwixFetch } from "./kiwix.js";
import { tryLlmsTxtFetch } from "./llms-txt.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { isRedditHost, redditFetch } from "./reddit.js";
import { checkRobots } from "./robots.js";
import { getTiers, TIER_NAME } from "./routing.js";
import { assertResolvedPublic } from "./ssrf-guard.js";
import {
  fetchRawHtmlForMetadata,
  githubFetch,
  isGithubUrl,
  tier2 as pdfTier,
  waybackFetch,
} from "./tiers/index.js";
import { isYouTubeHost, youtubeFetch } from "./youtube.js";

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
  maxChars = 8000,
): TierResult {
  const html = metadataHtml ?? fetched.html ?? null;
  if (!html) return fetched;
  const enriched = postExtract({
    url,
    html,
    baselineTitle: fetched.title,
    baselineText: fetched.text,
    maxChars,
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

// The fetch cache stores content at this size and callers slice it down on
// read. A caller requesting more than the historical 8000-char default (e.g. a
// large fetch_url max_tokens budget) raises the store size up to this hard
// ceiling; smaller requests still store 8000 so entries stay reusable.
const DEFAULT_FETCH_CHARS = 8000;
const FETCH_STORE_CEILING = 40000;

export async function fetchPage(
  url: string,
  maxChars = DEFAULT_FETCH_CHARS,
  domainProfile?: string,
  preferFit = false,
  tuning?: FetchTuning,
): Promise<{ title: string; url: string; text: string }> {
  return withSpan("fetch", { "fetch.url": url }, async () => {
    const t_total = Date.now();
    assertPublicUrl(url);
    // How much to actually fetch/store: at least the default (keeps cache
    // entries reusable), at most the hard ceiling, but never less than what the
    // caller asked to read back.
    const storeChars = Math.min(
      Math.max(maxChars, DEFAULT_FETCH_CHARS),
      FETCH_STORE_CEILING,
    );
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
        githubFetch(url, storeChars),
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
        tryLlmsTxtFetch(url, storeChars),
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
          kiwixFetch(url, storeChars),
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
        histerFetch(url, storeChars),
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

      // YouTube transcript fast path — timedtext captions for known video URLs.
      // Robots-gated by default (see youtubeFetch); on miss, falls through so
      // the cascade can still fetch the watch page's title/description.
      if (isYouTubeHost(url)) {
        const yt = await withSpan("youtube", { "fetch.url": url }, () =>
          youtubeFetch(url, storeChars),
        );
        if (yt) {
          incCounter("fetch", { tier: "youtube", outcome: "hit" });
          const persisted = { title: yt.title, url: yt.url, text: yt.text };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "youtube",
            title: yt.title,
            text_len: yt.text.length,
            latency_ms: Date.now() - t_total,
            source: "youtube",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        incCounter("fetch", { tier: "youtube", outcome: "miss" });
      }

      // Reddit fast path — public .json for post + top comments. Robots-gated by
      // default (see redditFetch); on miss, falls through to the cascade.
      if (isRedditHost(url)) {
        const rd = await withSpan("reddit", { "fetch.url": url }, () =>
          redditFetch(url, storeChars),
        );
        if (rd) {
          incCounter("fetch", { tier: "reddit", outcome: "hit" });
          const persisted = { title: rd.title, url: rd.url, text: rd.text };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "reddit",
            title: rd.title,
            text_len: rd.text.length,
            latency_ms: Date.now() - t_total,
            source: "reddit",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        incCounter("fetch", { tier: "reddit", outcome: "miss" });
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

      // Tier1 (Firecrawl) and tier2 (Crawl4AI) resolve and fetch the URL on our
      // behalf, so the connect-time DNS guard can't cover them. Pre-resolve the
      // hostname here (once, before any external-fetcher dispatch) so a public
      // hostname that DNS-rebinds to an internal address is rejected before it's
      // handed to those services — the string-level assertPublicUrl above only
      // catches literal private IPs. Throws SsrfBlockedError on a private
      // resolution (surfaces to the caller as a fetch error).
      await assertResolvedPublic(url);

      // PDF fast path — Firecrawl can't extract PDF text; route directly to tier2.
      if (isPdfUrl(url)) {
        const pdfResult = await runTier("tier2_crawl4ai", url, () =>
          pdfTier.fetch(url, storeChars, preferFit),
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
          tier.fetch(url, storeChars, preferFit, tuning),
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
          waybackFetch(url, storeChars),
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
        applyPostExtract(tierFetched, url, metadataHtml, storeChars),
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
