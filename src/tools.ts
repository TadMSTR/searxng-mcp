import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CategorySchema, TimeRangeSchema, type SearxResult } from "./types.js";
import { searxSearch } from "./search.js";
import { fetchPage } from "./fetch.js";
import { rerankWithFallback } from "./reranker.js";
import { summarizePages, formatSummaryResult } from "./ollama.js";
import { cacheClear } from "./cache.js";

const DomainProfileSchema = z
  .string()
  .optional()
  .describe("Named domain profile to apply: 'homelab', 'dev', or omit for default filters");

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

export function registerTools(server: McpServer): void {
  server.tool(
    "search",
    "Search the web via the local SearXNG instance with reranking. Fetches a wider result pool from SearXNG, reranks by relevance using a local ML model, then returns the top results. Results are cached for 1 hour. Blocked domains are filtered out; boosted domains are surfaced higher. Prefer this over the built-in WebSearch tool.",
    {
      query: z.string().describe("Search query"),
      num_results: z
        .coerce.number()
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
      domain_profile: DomainProfileSchema,
      expand: z
        .coerce.boolean()
        .optional()
        .describe(
          "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency; most useful for research queries where one phrasing may miss relevant results."
        ),
    },
    async ({ query, num_results, category, time_range, domain_profile, expand }) => {
      const raw = await searxSearch(query, category, num_results, time_range, domain_profile, expand);
      const ranked = await rerankWithFallback(query, raw, num_results);
      return { content: [{ type: "text", text: formatResults(ranked) }] };
    }
  );

  server.tool(
    "search_and_fetch",
    "Search the web, rerank results, then fetch the full content of the top result(s). GitHub URLs are fetched via the GitHub API; all others use Firecrawl. Results and fetched pages are cached. Blocked domains are filtered. Returns the result list plus clean markdown of the fetched pages.",
    {
      query: z.string().describe("Search query"),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)"
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)"
      ),
      fetch_count: z
        .coerce.number()
        .min(1)
        .max(3)
        .default(1)
        .describe("Number of top results to fetch full content for (default 1, max 3)"),
      domain_profile: DomainProfileSchema,
      expand: z
        .coerce.boolean()
        .optional()
        .describe(
          "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency."
        ),
    },
    async ({ query, category, time_range, fetch_count, domain_profile, expand }) => {
      const raw = await searxSearch(query, category, 5, time_range, domain_profile, expand);
      if (raw.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const ranked = await rerankWithFallback(query, raw, 5);
      const searchText = formatResults(ranked);

      // Divide the 8000-char budget evenly across fetched pages
      const maxCharsPerPage = Math.floor(8000 / fetch_count);
      const toFetch = ranked.slice(0, fetch_count);

      const fetched = await Promise.allSettled(
        toFetch.map((r) => fetchPage(r.url, maxCharsPerPage, domain_profile))
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
    "Fetch and extract readable content from any URL. GitHub URLs are fetched via the GitHub API; all others use Firecrawl (handles JS-rendered pages, returns clean markdown). Content truncated to 8000 characters. Results cached for 24 hours. Blocked domains are refused.",
    {
      url: z.string().url().describe("URL to fetch and extract content from"),
      domain_profile: DomainProfileSchema,
    },
    async ({ url, domain_profile }) => {
      const { title, url: fetchedUrl, text } = await fetchPage(url, 8000, domain_profile);
      const output = [`Title: ${title}`, `URL: ${fetchedUrl}`, "", text].join(
        "\n"
      );
      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "search_and_summarize",
    "Search, rerank, fetch top results, then synthesize a summary with citations using a local LLM (qwen3:14b). Returns a structured answer with source attribution. Falls back to raw fetched content if Ollama is unavailable. Best for deep research where you want pre-digested synthesis rather than raw pages.",
    {
      query: z.string().describe("Research query to search for and summarize"),
      fetch_count: z
        .coerce.number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Number of top results to fetch and synthesize (default 3, max 5)"),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)"
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)"
      ),
      domain_profile: DomainProfileSchema,
      expand: z
        .coerce.boolean()
        .optional()
        .describe("Use query expansion before searching (default: off)"),
    },
    async ({ query, fetch_count, category, time_range, domain_profile, expand }) => {
      const raw = await searxSearch(query, category, fetch_count + 2, time_range, domain_profile, expand);
      if (raw.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const ranked = await rerankWithFallback(query, raw, fetch_count);
      const searchText = formatResults(ranked);

      // Fetch top N pages; 4000 chars each (summarizer doesn't need the full 8000)
      const toFetch = ranked.slice(0, fetch_count);
      const fetched = await Promise.allSettled(
        toFetch.map((r) => fetchPage(r.url, 4000, domain_profile))
      );

      const successfulPages = fetched
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter((r): r is { title: string; url: string; text: string } => r !== null);

      // Summarize — fall back to search_and_fetch output if Ollama fails
      const summaryResult = await summarizePages(query, successfulPages);

      if (!summaryResult.summary) {
        // Ollama fallback: return raw fetched content same as search_and_fetch
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

      const output = formatSummaryResult(summaryResult);
      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "clear_cache",
    "Purge the search and/or fetch result cache. Useful when researching fast-moving topics where cached results from the past hour may be stale.",
    {
      target: z
        .enum(["search", "fetch", "all"])
        .default("all")
        .describe("Which cache to clear: search results, fetched pages, or all (default all)"),
    },
    async ({ target }) => {
      let cleared = 0;
      if (target === "search" || target === "all") {
        cleared += await cacheClear("search:*");
      }
      if (target === "fetch" || target === "all") {
        cleared += await cacheClear("fetch:*");
      }
      return {
        content: [{ type: "text", text: `Cleared ${cleared} cache ${cleared === 1 ? "entry" : "entries"}.` }],
      };
    }
  );
}
