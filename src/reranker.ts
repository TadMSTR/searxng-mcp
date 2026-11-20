import { RERANK_RECENCY_WEIGHT, RERANKER_URL } from "./config.js";
import { logThrottled } from "./log.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import type { RerankResponse, SearxResult } from "./types.js";

/** Exponential decay recency score. Returns 0 for missing/unparseable dates. */
export function recencyScore(date?: string): number {
  if (!date) return 0;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return 0;
  const ageDays = (Date.now() - ms) / 86_400_000;
  if (ageDays < 0) return 0; // future dates treated as neutral
  return Math.exp(-ageDays / 90);
}

/**
 * Numbers about one rerank, for span attributes and the top-score histogram.
 * All scores are the RAW cross-encoder relevance (0..1), the value min_score
 * filters on, not the recency-weighted sort key.
 */
interface RerankStats {
  /** Highest relevance in the whole candidate pool, before min_score. */
  topScore?: number;
  /** Lowest relevance among the results returned. */
  minReturnedScore?: number;
  /** Candidates removed by min_score. */
  droppedByMinScore: number;
}

async function rerank(
  query: string,
  results: SearxResult[],
  topN: number,
  applyRecency: boolean,
  minScore?: number,
): Promise<{ results: SearxResult[]; stats: RerankStats }> {
  if (results.length === 0) {
    return { results, stats: { droppedByMinScore: 0 } };
  }

  const documents = results.map((r) => `${r.title}. ${r.content ?? ""}`.trim());

  const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Request scores for the full pool so the recency re-sort has all candidates.
    // FlashRank scores all documents regardless of top_n — this is a return-count
    // change only, not a compute change.
    body: JSON.stringify({ query, documents, top_n: results.length }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Reranker error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RerankResponse;

  const scored = data.results
    .filter((r) => r.index >= 0 && r.index < results.length)
    .map((r) => {
      const result = results[r.index];
      const combined =
        applyRecency && RERANK_RECENCY_WEIGHT > 0
          ? r.relevance_score +
            RERANK_RECENCY_WEIGHT * recencyScore(result.publishedDate)
          : r.relevance_score;
      // `relevance` is carried alongside `score` rather than being discarded
      // here, because the two are NOT interchangeable and `min_score` must
      // filter on the raw one. See the filter below.
      return { result, score: combined, relevance: r.relevance_score };
    });

  // Filter BEFORE sort-and-slice. Slicing first would return fewer than `topN`
  // results even when enough qualifying ones existed further down the pool.
  //
  // Filtering on `relevance` (raw cross-encoder) and NOT on `score` (which adds
  // RERANK_RECENCY_WEIGHT * recencyScore) is deliberate. The combined value
  // ranges over 0..1.15 with the default weight of 0.15, so a parameter named
  // "minimum relevance" applied to it would silently let a low-relevance but
  // recent document past a threshold the caller believed was about relevance.
  const kept =
    minScore === undefined
      ? scored
      : scored.filter((s) => s.relevance >= minScore);

  kept.sort((a, b) => b.score - a.score);
  const returned = kept.slice(0, topN);
  const relevances = scored.map((s) => s.relevance);
  const returnedRelevances = returned.map((s) => s.relevance);
  return {
    results: returned.map((s) => s.result),
    stats: {
      topScore: relevances.length > 0 ? Math.max(...relevances) : undefined,
      minReturnedScore:
        returnedRelevances.length > 0
          ? Math.min(...returnedRelevances)
          : undefined,
      droppedByMinScore: scored.length - kept.length,
    },
  };
}

export async function rerankWithFallback(
  query: string,
  results: SearxResult[],
  topN: number,
  timeRange?: string,
  minScore?: number,
): Promise<SearxResult[]> {
  return withSpan(
    "rerank",
    {
      "rerank.candidates": results.length,
      "rerank.top_n": topN,
      "rerank.min_score": minScore,
    },
    async (span) => {
      // Only numbers and booleans on this span: no result text or URLs.
      const mark = (applied: boolean, returned: number, stats?: RerankStats) =>
        span?.setAttributes({
          "rerank.applied": applied,
          "rerank.returned": returned,
          ...(stats?.topScore !== undefined && {
            "rerank.top_score": stats.topScore,
          }),
          ...(stats?.minReturnedScore !== undefined && {
            "rerank.min_returned_score": stats.minReturnedScore,
          }),
          ...(stats !== undefined && {
            "rerank.dropped_by_min_score": stats.droppedByMinScore,
          }),
        });
      // An empty RERANKER_URL means "no reranker", and must actually mean it.
      //
      // Same shape as the CACHE_URL guard in cache.ts, for the same reason:
      // RERANKER_URL defaults to http://localhost:8787 and has no kill switch,
      // so "" is the only way off — and `fetch("" + "/v1/rerank")` is a
      // relative URL, which throws `Failed to parse URL from /v1/rerank` on
      // every single search. It fell through to the fallback below, so results
      // were correct, but each search paid a throw and logged a degradation
      // notice for a service the operator had deliberately not deployed.
      //
      // Returning here rather than throwing keeps "I turned it off" distinct
      // from "it broke" in the log, which is the whole point of the tri-state
      // capability line (vikunja#695).
      if (RERANKER_URL === "") {
        const out = results.slice(0, topN);
        mark(false, out.length);
        return out;
      }

      const applyRecency = !timeRange; // skip when caller already filtered by date
      try {
        const { results: out, stats } = await rerank(
          query,
          results,
          topN,
          applyRecency,
          minScore,
        );
        mark(true, out.length, stats);
        // The input for tuning min_score defaults: what the best candidate
        // scores, per reranked search. An empty pool has no score to record.
        if (stats.topScore !== undefined) {
          recordHistogram("rerank_top_score", stats.topScore);
        }
        return out;
      } catch (err) {
        // Reranker unavailable — fall back to SearXNG order. Silent otherwise;
        // one throttled line makes "why did ranking quality drop" answerable.
        // The log line is throttled; the counter counts every occurrence.
        incCounter("degrade", { component: "reranker", reason: "unavailable" });
        logThrottled(
          "degrade:reranker",
          `reranker unavailable — using SearXNG result order: ${err instanceof Error ? err.message : String(err)}`,
        );
        // `min_score` becomes a documented NO-OP here, and says so. There are
        // no scores to filter on in this path, so the alternatives were: return
        // everything silently, which would let a caller believe a relevance
        // floor was applied when none was; or return nothing, which turns a
        // reranker outage into an empty result set. Both are worse than
        // unfiltered-and-announced.
        if (minScore !== undefined) {
          incCounter("degrade", {
            component: "reranker",
            reason: "min_score_ignored",
          });
          logThrottled(
            "degrade:reranker:min_score",
            `min_score=${minScore} ignored — reranker unavailable, so no relevance scores exist to filter on; returning unfiltered SearXNG order`,
          );
        }
        const out = results.slice(0, topN);
        mark(false, out.length);
        return out;
      }
    },
  );
}
