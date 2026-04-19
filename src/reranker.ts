import { RERANK_RECENCY_WEIGHT, RERANKER_URL } from "./config.js";
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

async function rerank(
  query: string,
  results: SearxResult[],
  topN: number,
  applyRecency: boolean,
): Promise<SearxResult[]> {
  if (results.length === 0) return results;

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
      return { result, score: combined };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.result);
}

export async function rerankWithFallback(
  query: string,
  results: SearxResult[],
  topN: number,
  timeRange?: string,
): Promise<SearxResult[]> {
  const applyRecency = !timeRange; // skip when caller already filtered by date
  try {
    return await rerank(query, results, topN, applyRecency);
  } catch {
    // Reranker unavailable — fall back to SearXNG order
    return results.slice(0, topN);
  }
}
