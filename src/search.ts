import { cacheGet, cacheSet, searchCacheKey } from "./cache.js";
import {
  CACHE_TTL_SECONDS,
  EXPAND_QUERIES_DEFAULT,
  SEARXNG_URL,
} from "./config.js";
import { applyDomainFilters } from "./domains.js";
import { expandQuery } from "./ollama.js";
import type { SearxResponse, SearxResult } from "./types.js";

export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
): Promise<SearxResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: category,
    pageno: "1",
  });
  if (timeRange) params.set("time_range", timeRange);

  const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as SearxResponse;
  return data.results.slice(0, fetchCount);
}

export async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean,
): Promise<SearxResult[]> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Check cache first (keyed on original query — expansion results are not cached separately)
  const key = searchCacheKey(query, category, timeRange);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const results = JSON.parse(cached) as SearxResult[];
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
      expandQuery(query),
      searxSearchSingle(query, category, fetchCount, timeRange),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingle(v, category, fetchCount, timeRange),
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

    return applyDomainFilters(merged, domainProfile);
  }

  // Non-expanded path
  const raw = await searxSearchSingle(query, category, fetchCount, timeRange);

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  await cacheSet(key, JSON.stringify(raw), CACHE_TTL_SECONDS);

  return applyDomainFilters(raw, domainProfile);
}
