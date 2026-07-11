import { cacheGet, cacheSet, searchCacheKey } from "./cache.js";
import {
  CACHE_TTL_SECONDS,
  EXPAND_QUERIES_DEFAULT,
  SEARXNG_URL,
} from "./config.js";
import { normalizeHostname, recordSearchAppearance } from "./domain-db.js";
import { applyDomainFilters } from "./domains.js";
import { withSpan } from "./observability.js";
import { expandQuery } from "./ollama.js";
import type { SearxResponse, SearxResult } from "./types.js";

// Fire-and-forget: mark each unique domain among the results as "seen in
// search" so dump-domain can distinguish that from "never seen at all".
// Cheap by design — deduplicated to one write per unique domain (not per
// result URL), no fetch performed, and never awaited on the response path.
function recordSearchAppearances(results: SearxResult[]): void {
  const domains = new Set<string>();
  for (const r of results) {
    const host = normalizeHostname(r.url);
    if (host) domains.add(host);
  }
  for (const host of domains) {
    recordSearchAppearance(host).catch(() => {});
  }
}

export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
): Promise<SearxResult[]> {
  return withSpan(
    "searxng_request",
    { "search.category": category, "search.time_range": timeRange },
    async () => {
      const params = new URLSearchParams({
        q: query,
        format: "json",
        categories: category,
        pageno: "1",
      });
      if (timeRange) params.set("time_range", timeRange);
      if (language) params.set("language", language);

      const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok)
        throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as SearxResponse;
      return data.results.slice(0, fetchCount);
    },
  );
}

export async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean,
  language?: string,
): Promise<SearxResult[]> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Check cache first (keyed on original query — expansion results are not cached separately)
  const key = searchCacheKey(query, category, timeRange);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const results = JSON.parse(cached) as SearxResult[];
      recordSearchAppearances(results);
      // Domain filtering applied after cache retrieval so profile changes take effect immediately
      return applyDomainFilters(results, domainProfile);
    } catch {
      // Corrupted cache entry — fall through to live fetch
    }
  }

  // Fetch more than needed so reranker has a larger pool to work with
  const fetchCount = Math.min(numResults * 3, 20);

  if (shouldExpand) {
    // Run original query + expanded variants in parallel, merge, deduplicate by URL
    const [variants, originalResults] = await Promise.all([
      withSpan("expand_query", { "query.expand": true }, () =>
        expandQuery(query),
      ),
      searxSearchSingle(query, category, fetchCount, timeRange, language),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingle(v, category, fetchCount, timeRange, language),
      ),
    );

    // Merge: original results first, then variant results; deduplicate by URL
    const seen = new Set<string>();
    const merged: SearxResult[] = [];
    for (const r of originalResults) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        merged.push(r);
      }
    }
    for (const settled of variantResults) {
      if (settled.status === "fulfilled") {
        for (const r of settled.value) {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            merged.push(r);
          }
        }
      }
    }

    // Cache only the original query results (not the expanded pool)
    await cacheSet(key, JSON.stringify(originalResults), CACHE_TTL_SECONDS);

    recordSearchAppearances(merged);
    return applyDomainFilters(merged, domainProfile);
  }

  // Non-expanded path
  const raw = await searxSearchSingle(
    query,
    category,
    fetchCount,
    timeRange,
    language,
  );

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  await cacheSet(key, JSON.stringify(raw), CACHE_TTL_SECONDS);

  recordSearchAppearances(raw);
  return applyDomainFilters(raw, domainProfile);
}
