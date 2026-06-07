export const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8081";
export const FIRECRAWL_URL =
  process.env.FIRECRAWL_URL ?? "http://localhost:3002";
export const FIRECRAWL_API_KEY =
  process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
export const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const CACHE_URL =
  process.env.CACHE_URL ??
  process.env.VALKEY_URL ??
  process.env.REDIS_URL ??
  "redis://localhost:6381";
export const CACHE_TTL_SECONDS = parseInt(
  process.env.CACHE_TTL_SECONDS ?? "3600",
  10,
);
export const FETCH_CACHE_TTL_SECONDS = parseInt(
  process.env.FETCH_CACHE_TTL_SECONDS ?? "86400",
  10,
);
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "";
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? "";
export const OLLAMA_EXPAND_MODEL =
  process.env.OLLAMA_EXPAND_MODEL ?? "qwen3:4b";
export const OLLAMA_SUMMARIZE_MODEL =
  process.env.OLLAMA_SUMMARIZE_MODEL ?? "qwen3:14b";
export const EXPAND_QUERIES_DEFAULT = process.env.EXPAND_QUERIES === "true";
export const KIWIX_URL = process.env.KIWIX_URL?.replace(/\/$/, "") ?? "";
export const HISTER_URL = process.env.HISTER_URL?.replace(/\/$/, "") ?? "";
export const HISTER_TOKEN = process.env.HISTER_TOKEN ?? "";
export const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? null;
export const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN;
export const WAYBACK_ENABLED = process.env.WAYBACK_ENABLED === "true";
export const ADBLOCK_PROXY_URL = process.env.ADBLOCK_PROXY_URL ?? null;
export const TRANSPORT = process.env.SEARXNG_MCP_TRANSPORT ?? "stdio"; // "stdio" | "http"
export const HTTP_PORT = parseInt(process.env.SEARXNG_MCP_PORT ?? "3001", 10);
export const HTTP_HOST = process.env.SEARXNG_MCP_HOST ?? "127.0.0.1";
export const CRAWL_MANIFEST_TTL_SECONDS = parseInt(
  process.env.CRAWL_MANIFEST_TTL_SECONDS ?? "21600",
  10,
);
export const CRAWL_MAX_PAGES_DEFAULT = parseInt(
  process.env.CRAWL_MAX_PAGES_DEFAULT ?? "20",
  10,
);
export const CRAWL_BFS_ENABLED = process.env.CRAWL_BFS_ENABLED === "true";
export const CRAWL_BFS_MAX_DEPTH = parseInt(
  process.env.CRAWL_BFS_MAX_DEPTH ?? "3",
  10,
);
export const FIRECRAWL_CRAWL_POLL_INTERVAL_MS = parseInt(
  process.env.FIRECRAWL_CRAWL_POLL_INTERVAL_MS ?? "2000",
  10,
);
export const FIRECRAWL_CRAWL_MAX_WAIT_MS = parseInt(
  process.env.FIRECRAWL_CRAWL_MAX_WAIT_MS ?? "120000",
  10,
);

export const RERANK_RECENCY_WEIGHT = (() => {
  const v = parseFloat(process.env.RERANK_RECENCY_WEIGHT ?? "0.15");
  if (Number.isNaN(v) || v < 0) {
    console.warn(
      `[searxng-mcp] RERANK_RECENCY_WEIGHT="${process.env.RERANK_RECENCY_WEIGHT}" is invalid; recency weighting disabled.`,
    );
    return 0;
  }
  if (v > 1) {
    console.warn(
      `[searxng-mcp] RERANK_RECENCY_WEIGHT=${v} exceeds 1.0; recency may dominate relevance scores.`,
    );
  }
  return v;
})();
