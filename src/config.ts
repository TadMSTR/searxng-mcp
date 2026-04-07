export const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8081";
export const FIRECRAWL_URL = process.env.FIRECRAWL_URL ?? "http://localhost:3002";
export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
export const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6381";
export const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS ?? "3600", 10);
export const FETCH_CACHE_TTL_SECONDS = parseInt(process.env.FETCH_CACHE_TTL_SECONDS ?? "86400", 10);
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "";
export const EXPAND_QUERIES_DEFAULT = process.env.EXPAND_QUERIES === "true";
export const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? null;
export const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN;
export const RERANK_RECENCY_WEIGHT = parseFloat(
  process.env.RERANK_RECENCY_WEIGHT ?? "0.15"
);
