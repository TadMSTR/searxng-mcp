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
import type {
  SearxMeta,
  SearxResponse,
  SearxResult,
  SearxSearchResult,
} from "./types.js";

const EMPTY_META: SearxMeta = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

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

// Build a `site:` query prefix from a single domain or a list. Best-effort:
// most engines (Google, Bing, DDG, Brave) honor the site: operator, but some
// ignore it — documented in the tool descriptions, not guaranteed here.
function siteFilterPrefix(site?: string | string[]): string {
  if (!site) return "";
  const domains = (Array.isArray(site) ? site : [site])
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) return "";
  if (domains.length === 1) return `site:${domains[0]} `;
  return `(${domains.map((d) => `site:${d}`).join(" OR ")}) `;
}

// Collapse SearXNG's version-varying answers/infoboxes/corrections/suggestions
// into the normalized SearxMeta shape. Silently drops empty entries.
export function normalizeSearxMeta(data: SearxResponse): SearxMeta {
  const answers = (data.answers ?? [])
    .map((a) =>
      typeof a === "string"
        ? { answer: a }
        : { answer: a.answer ?? a.content ?? "", url: a.url },
    )
    .filter((a) => a.answer.trim().length > 0);

  const infoboxes = (data.infoboxes ?? [])
    .map((ib) => ({
      title: ib.infobox ?? "",
      content: ib.content ?? "",
      url: ib.urls?.[0]?.url,
    }))
    .filter((ib) => ib.title.trim().length > 0 || ib.content.trim().length > 0);

  const corrections = (data.corrections ?? [])
    .map((c) => (typeof c === "string" ? c : (c.title ?? "")))
    .filter((c) => c.trim().length > 0);

  const suggestions = (data.suggestions ?? []).filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );

  return { answers, infoboxes, corrections, suggestions };
}

export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  return withSpan(
    "searxng_request",
    { "search.category": category, "search.time_range": timeRange },
    async () => {
      const params = new URLSearchParams({
        q: siteFilterPrefix(site) + query,
        format: "json",
        categories: category,
        pageno: "1",
      });
      if (timeRange) params.set("time_range", timeRange);
      if (language) params.set("language", language);
      // Arbitrary engine selection, forwarded verbatim. Unknown/disabled engine
      // names degrade at SearXNG (empty results), matching how `category` fails
      // soft rather than erroring.
      if (engines) params.set("engines", engines);

      const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok)
        throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as SearxResponse;
      return {
        results: data.results.slice(0, fetchCount),
        meta: normalizeSearxMeta(data),
      };
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
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Cache key must discriminate on engines/site — same query text with a
  // different engine set or site filter is a different search.
  const siteKey = Array.isArray(site) ? site.join(",") : (site ?? "");
  const cacheKeyInput = `${query}|engines=${engines ?? ""}|site=${siteKey}`;
  const key = searchCacheKey(cacheKeyInput, category, timeRange);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const parsed = JSON.parse(cached) as
        | SearxResult[]
        | { results: SearxResult[]; meta?: SearxMeta };
      const results = Array.isArray(parsed) ? parsed : parsed.results;
      const meta = Array.isArray(parsed)
        ? EMPTY_META
        : (parsed.meta ?? EMPTY_META);
      recordSearchAppearances(results);
      // Domain filtering applied after cache retrieval so profile changes take effect immediately
      return { results: applyDomainFilters(results, domainProfile), meta };
    } catch {
      // Corrupted cache entry — fall through to live fetch
    }
  }

  // Fetch more than needed so reranker has a larger pool to work with
  const fetchCount = Math.min(numResults * 3, 20);

  if (shouldExpand) {
    // Run original query + expanded variants in parallel, merge, deduplicate by URL
    const [variants, original] = await Promise.all([
      withSpan("expand_query", { "query.expand": true }, () =>
        expandQuery(query),
      ),
      searxSearchSingle(
        query,
        category,
        fetchCount,
        timeRange,
        language,
        engines,
        site,
      ),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingle(
          v,
          category,
          fetchCount,
          timeRange,
          language,
          engines,
          site,
        ),
      ),
    );

    // Merge: original results first, then variant results; deduplicate by URL.
    // Meta comes from the original query only.
    const seen = new Set<string>();
    const merged: SearxResult[] = [];
    for (const r of original.results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        merged.push(r);
      }
    }
    for (const settled of variantResults) {
      if (settled.status === "fulfilled") {
        for (const r of settled.value.results) {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            merged.push(r);
          }
        }
      }
    }

    // Cache only the original query results (not the expanded pool)
    await cacheSet(
      key,
      JSON.stringify({ results: original.results, meta: original.meta }),
      CACHE_TTL_SECONDS,
    );

    recordSearchAppearances(merged);
    return {
      results: applyDomainFilters(merged, domainProfile),
      meta: original.meta,
    };
  }

  // Non-expanded path
  const raw = await searxSearchSingle(
    query,
    category,
    fetchCount,
    timeRange,
    language,
    engines,
    site,
  );

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  await cacheSet(
    key,
    JSON.stringify({ results: raw.results, meta: raw.meta }),
    CACHE_TTL_SECONDS,
  );

  recordSearchAppearances(raw.results);
  return {
    results: applyDomainFilters(raw.results, domainProfile),
    meta: raw.meta,
  };
}
