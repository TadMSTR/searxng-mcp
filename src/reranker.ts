import { RERANKER_URL } from "./config.js";
import type { SearxResult, RerankResponse } from "./types.js";

async function rerank(
  query: string,
  results: SearxResult[],
  topN: number
): Promise<SearxResult[]> {
  if (results.length === 0) return results;

  const documents = results.map(
    (r) => `${r.title}. ${r.content ?? ""}`.trim()
  );

  const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, documents, top_n: topN }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Reranker error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RerankResponse;
  return data.results
    .filter((r) => r.index >= 0 && r.index < results.length)
    .map((r) => results[r.index]);
}

export async function rerankWithFallback(
  query: string,
  results: SearxResult[],
  topN: number
): Promise<SearxResult[]> {
  try {
    return await rerank(query, results, topN);
  } catch {
    // Reranker unavailable — fall back to SearXNG order
    return results.slice(0, topN);
  }
}
