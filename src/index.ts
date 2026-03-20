#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8081";
const FIRECRAWL_URL = process.env.FIRECRAWL_URL ?? "http://localhost:3002";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";

const CategorySchema = z
  .enum(["general", "news", "it", "science"])
  .default("general");

const TimeRangeSchema = z
  .enum(["day", "week", "month", "year"])
  .optional();

// --- SearXNG types ---

interface SearxResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
}

interface SearxResponse {
  results: SearxResult[];
}

// --- Firecrawl types ---

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

// --- Reranker types ---

interface RerankResult {
  index: number;
  relevance_score: number;
}

interface RerankResponse {
  results: RerankResult[];
}

// --- URL safety ---

function assertPublicUrl(url: string): void {
  const { hostname, protocol } = new URL(url);
  if (!/^https?:$/.test(protocol)) {
    throw new Error(`Only http/https URLs are supported`);
  }
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^host\.docker\.internal$/i,
    /^fc00:/i,
    /^fe80:/i,
  ];
  if (blocked.some((r) => r.test(hostname))) {
    throw new Error(`Internal/private addresses are not allowed`);
  }
}

// --- SearXNG ---

async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string
): Promise<SearxResult[]> {
  // Fetch more than needed so reranker has a larger pool to work with
  const fetchCount = Math.min(numResults * 3, 20);

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
  if (!res.ok) {
    throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as SearxResponse;
  return data.results.slice(0, fetchCount);
}

// --- Reranker ---

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

async function rerankWithFallback(
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

// --- Firecrawl ---

async function firecrawlScrape(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string }> {
  assertPublicUrl(url);
  const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Firecrawl error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    throw new Error(data.error ?? "Firecrawl returned no data");
  }

  const title = data.data.metadata?.title ?? url;
  const text = (data.data.markdown ?? "").slice(0, maxChars);

  return { title, url: data.data.metadata?.sourceURL ?? url, text };
}

// --- Formatting ---

function formatResults(results: SearxResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const engine = r.engines?.[0] ?? r.engine ?? "unknown";
      const date = r.publishedDate ? ` [${r.publishedDate}]` : "";
      const snippet = r.content ? `\n   ${r.content.slice(0, 250)}` : "";
      return `${i + 1}. ${r.title}${date}\n   URL: ${r.url}\n   Source: ${engine}${snippet}`;
    })
    .join("\n\n");
}

// --- Server ---

const server = new McpServer({
  name: "searxng-mcp",
  version: "2.0.0",
});

server.tool(
  "search",
  "Search the web via the local SearXNG instance with reranking. Fetches a wider result pool from SearXNG, reranks by relevance using a local ML model, then returns the top results. Prefer this over the built-in WebSearch tool.",
  {
    query: z.string().describe("Search query"),
    num_results: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of results to return (default 5, max 20)"),
    category: CategorySchema.describe(
      "Search category: general, news, it, or science (default general)"
    ),
    time_range: TimeRangeSchema.describe(
      "Limit results to: day, week, month, or year (omit for all time)"
    ),
  },
  async ({ query, num_results, category, time_range }) => {
    const raw = await searxSearch(query, category, num_results, time_range);
    const ranked = await rerankWithFallback(query, raw, num_results);
    return { content: [{ type: "text", text: formatResults(ranked) }] };
  }
);

server.tool(
  "search_and_fetch",
  "Search the web, rerank results, then fetch the full content of the top result(s) using Firecrawl (handles JS-rendered pages). Returns the result list plus clean markdown of the fetched pages.",
  {
    query: z.string().describe("Search query"),
    category: CategorySchema.describe(
      "Search category: general, news, it, or science (default general)"
    ),
    time_range: TimeRangeSchema.describe(
      "Limit results to: day, week, month, or year (omit for all time)"
    ),
    fetch_count: z
      .number()
      .min(1)
      .max(3)
      .default(1)
      .describe("Number of top results to fetch full content for (default 1, max 3)"),
  },
  async ({ query, category, time_range, fetch_count }) => {
    const raw = await searxSearch(query, category, 5, time_range);
    if (raw.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const ranked = await rerankWithFallback(query, raw, 5);
    const searchText = formatResults(ranked);

    // Divide the 8000-char budget evenly across fetched pages
    const maxCharsPerPage = Math.floor(8000 / fetch_count);
    const toFetch = ranked.slice(0, fetch_count);

    const fetched = await Promise.allSettled(
      toFetch.map((r) => firecrawlScrape(r.url, maxCharsPerPage))
    );

    const fetchedSections = fetched
      .map((result, i) => {
        if (result.status === "fulfilled") {
          const { title, text } = result.value;
          return `\n\n--- Full content: ${title} ---\n${text}`;
        } else {
          const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
          return `\n\n--- Could not fetch result ${i + 1}: ${err} ---`;
        }
      })
      .join("");

    return { content: [{ type: "text", text: searchText + fetchedSections }] };
  }
);

server.tool(
  "fetch_url",
  "Fetch and extract readable content from any URL using Firecrawl (handles JS-rendered pages, returns clean markdown). Content truncated to 8000 characters.",
  {
    url: z.string().url().describe("URL to fetch and extract content from"),
  },
  async ({ url }) => {
    const { title, url: fetchedUrl, text } = await firecrawlScrape(url);
    const output = [`Title: ${title}`, `URL: ${fetchedUrl}`, "", text].join(
      "\n"
    );
    return { content: [{ type: "text", text: output }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
