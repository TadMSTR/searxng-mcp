import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheClear } from "./cache.js";
import { newRequestId, withRequestId } from "./context.js";
import { crawlSite, formatCrawlManifest } from "./crawl.js";
import { getDomainRecord } from "./domain-db.js";
import {
  aggregateDomainStats,
  enumerateDomains,
  formatDomainAggregate,
  formatDomainRecord,
  summarizeDomainRecord,
} from "./domain-stats.js";
import { events } from "./events.js";
import { fetchPage } from "./fetch.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { formatSummaryResult, summarizePages } from "./ollama.js";
import { rerankWithFallback } from "./reranker.js";
import { searxSearch } from "./search.js";
import { CategorySchema, type SearxResult, TimeRangeSchema } from "./types.js";

async function instrumentTool<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequestId(newRequestId(), () =>
    withSpan(`tool.${toolName}`, { "mcp.tool": toolName }, fn),
  );
}

interface SearchEventCtx {
  query: string;
  profile?: string;
  expand?: boolean;
  time_range?: string;
  num_results: number;
}

async function withSearchEvents<T>(
  ctx: SearchEventCtx,
  fn: () => Promise<{
    ranked: SearxResult[];
    result: T;
    rerankApplied: boolean;
  }>,
): Promise<T> {
  events.searchRequested(ctx);
  const t0 = Date.now();
  try {
    const { ranked, result, rerankApplied } = await fn();
    const latency_ms = Date.now() - t0;
    incCounter("search", {
      profile: ctx.profile ?? "default",
      expand: ctx.expand ? "true" : "false",
    });
    recordHistogram("search", latency_ms / 1000, {
      profile: ctx.profile ?? "default",
    });
    events.searchCompleted({
      result_count: ranked.length,
      latency_ms,
      sources: ranked.map((r) => new URL(r.url).hostname),
      rerank_applied: rerankApplied,
    });
    return result;
  } catch (err) {
    incCounter("errors", {
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
    });
    events.error({
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

const DomainProfileSchema = z
  .string()
  .optional()
  .describe(
    "Named domain profile to apply: 'homelab', 'dev', or omit for default filters",
  );

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

export async function handleSearch({
  query,
  num_results,
  category,
  time_range,
  domain_profile,
  expand,
  language,
}: {
  query: string;
  num_results: number;
  category?: string;
  time_range?: string;
  domain_profile?: string;
  expand?: boolean;
  language?: string;
}) {
  return instrumentTool("search", () =>
    withSearchEvents(
      { query, profile: domain_profile, expand, time_range, num_results },
      async () => {
        const raw = await searxSearch(
          query,
          category ?? "general",
          num_results,
          time_range,
          domain_profile,
          expand,
          language,
        );
        const ranked = await rerankWithFallback(
          query,
          raw,
          num_results,
          time_range,
        );
        return {
          ranked,
          rerankApplied: true,
          result: {
            content: [{ type: "text" as const, text: formatResults(ranked) }],
          },
        };
      },
    ),
  );
}

export async function handleSearchAndFetch({
  query,
  category,
  time_range,
  fetch_count,
  domain_profile,
  expand,
  language,
}: {
  query: string;
  category?: string;
  time_range?: string;
  fetch_count: number;
  domain_profile?: string;
  expand?: boolean;
  language?: string;
}) {
  return instrumentTool("search_and_fetch", () =>
    withSearchEvents(
      {
        query,
        profile: domain_profile,
        expand,
        time_range,
        num_results: fetch_count,
      },
      async () => {
        const raw = await searxSearch(
          query,
          category ?? "general",
          5,
          time_range,
          domain_profile,
          expand,
          language,
        );
        if (raw.length === 0) {
          return {
            ranked: [],
            rerankApplied: false,
            result: {
              content: [{ type: "text" as const, text: "No results found." }],
            },
          };
        }
        const ranked = await rerankWithFallback(query, raw, 5, time_range);
        const searchText = formatResults(ranked);
        const maxCharsPerPage = Math.floor(8000 / fetch_count);
        const toFetch = ranked.slice(0, fetch_count);
        const fetched = await Promise.allSettled(
          toFetch.map((r) => fetchPage(r.url, maxCharsPerPage, domain_profile)),
        );
        const fetchedSections = fetched
          .map((result, i) => {
            if (result.status === "fulfilled") {
              const { title, text } = result.value;
              return `\n\n--- Full content: ${title} ---\n${text}`;
            }
            const err =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            return `\n\n--- Could not fetch result ${i + 1}: ${err} ---`;
          })
          .join("");
        return {
          ranked,
          rerankApplied: true,
          result: {
            content: [
              { type: "text" as const, text: searchText + fetchedSections },
            ],
          },
        };
      },
    ),
  );
}

export async function handleSearchAndSummarize({
  query,
  fetch_count,
  category,
  time_range,
  domain_profile,
  expand,
  language,
}: {
  query: string;
  fetch_count: number;
  category?: string;
  time_range?: string;
  domain_profile?: string;
  expand?: boolean;
  language?: string;
}) {
  return instrumentTool("search_and_summarize", () =>
    withSearchEvents(
      {
        query,
        profile: domain_profile,
        expand,
        time_range,
        num_results: fetch_count,
      },
      async () => {
        const raw = await searxSearch(
          query,
          category ?? "general",
          fetch_count + 2,
          time_range,
          domain_profile,
          expand,
          language,
        );
        if (raw.length === 0) {
          return {
            ranked: [],
            rerankApplied: false,
            result: {
              content: [{ type: "text" as const, text: "No results found." }],
            },
          };
        }
        const ranked = await rerankWithFallback(
          query,
          raw,
          fetch_count,
          time_range,
        );
        const searchText = formatResults(ranked);
        const toFetch = ranked.slice(0, fetch_count);
        const fetched = await Promise.allSettled(
          toFetch.map((r) => fetchPage(r.url, 4000, domain_profile, true)),
        );
        const successfulPages = fetched
          .map((r) => (r.status === "fulfilled" ? r.value : null))
          .filter(
            (r): r is { title: string; url: string; text: string } =>
              r !== null,
          );
        const summaryResult = await withSpan(
          "summarize_llm",
          { "summary.pages": successfulPages.length },
          () => summarizePages(query, successfulPages),
        );

        if (!summaryResult.summary) {
          const fetchedSections = fetched
            .map((result, i) => {
              if (result.status === "fulfilled") {
                const { title, text } = result.value;
                return `\n\n--- Full content: ${title} ---\n${text}`;
              }
              const err =
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason);
              return `\n\n--- Could not fetch result ${i + 1}: ${err} ---`;
            })
            .join("");
          return {
            ranked,
            rerankApplied: true,
            result: {
              content: [
                { type: "text" as const, text: searchText + fetchedSections },
              ],
            },
          };
        }
        const output = formatSummaryResult(summaryResult);
        return {
          ranked,
          rerankApplied: true,
          result: { content: [{ type: "text" as const, text: output }] },
        };
      },
    ),
  );
}

export async function handleFetchUrl({
  url,
  domain_profile,
}: {
  url: string;
  domain_profile?: string;
}) {
  return instrumentTool("fetch_url", async () => {
    const {
      title,
      url: fetchedUrl,
      text,
    } = await fetchPage(url, 8000, domain_profile);
    const output = [`Title: ${title}`, `URL: ${fetchedUrl}`, "", text].join(
      "\n",
    );
    return { content: [{ type: "text" as const, text: output }] };
  });
}

export async function handleCrawlSite({
  url,
  max_pages,
  same_domain_only,
  include_path,
  exclude_path,
}: {
  url: string;
  max_pages: number;
  same_domain_only: boolean;
  include_path?: string;
  exclude_path?: string;
}) {
  return instrumentTool("crawl_site", async () => {
    const t0 = Date.now();
    events.crawlRequested({ url, max_pages, same_domain_only });
    const manifest = await crawlSite(
      url,
      max_pages,
      same_domain_only,
      include_path,
      exclude_path,
    );
    const latency_ms = Date.now() - t0;
    events.crawlCompleted({
      url,
      strategy: manifest.strategy,
      page_count: manifest.page_count,
      latency_ms,
      cached: manifest.cached,
    });
    incCounter("crawl", {
      outcome: manifest.strategy === "error" ? "error" : "success",
    });
    recordHistogram("tool.crawl_site", latency_ms / 1000, {});
    return {
      content: [{ type: "text" as const, text: formatCrawlManifest(manifest) }],
    };
  });
}

export async function handleClearCache({ target }: { target: string }) {
  return instrumentTool("clear_cache", async () => {
    let cleared = 0;
    if (target === "search" || target === "all") {
      cleared += await cacheClear("search:*");
    }
    if (target === "fetch" || target === "all") {
      cleared += await cacheClear("fetch:*");
    }
    if (target === "crawl" || target === "all") {
      cleared += await cacheClear("crawl:*");
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Cleared ${cleared} cache ${cleared === 1 ? "entry" : "entries"}.`,
        },
      ],
    };
  });
}

// ── domain_stats structured output ──────────────────────────────────────────
// Single Zod object covering both tool modes; the other mode's slot is null.
// The SDK validates returned `structuredContent` against this before it leaves
// the server and advertises the derived JSON Schema in tools/list.

const TierStatsOutputSchema = z.object({
  attempts: z.number(),
  ok: z.number(),
  fail: z.number(),
  success_rate: z.number().nullable(),
});

const AllTiersOutputSchema = z.object({
  tier1: TierStatsOutputSchema,
  tier2: TierStatsOutputSchema,
  tier3: TierStatsOutputSchema,
  tier4: TierStatsOutputSchema,
  github: TierStatsOutputSchema,
});

const SingleDomainOutputSchema = z.object({
  domain: z.string(),
  first_seen: z.string(),
  last_fetch: z.string(),
  preferred_strategy: z.string().nullable(),
  tiers: AllTiersOutputSchema,
  capabilities: z.object({
    llms_full_txt: z.boolean(),
    robots_allows_us: z.boolean().nullable(),
    metadata_fetch_rate: z.number().nullable(),
    seen_in_search: z.number(),
  }),
});

const AggregateOutputSchema = z.object({
  domains_tracked: z.number(),
  seen_never_fetched: z.number(),
  tiers: AllTiersOutputSchema,
  top_failing: z.array(
    z.object({
      domain: z.string(),
      attempts: z.number(),
      ok: z.number(),
      success_rate: z.number(),
    }),
  ),
  truncated: z.boolean(),
});

const DomainStatsOutputSchema = z.object({
  mode: z.enum(["single", "aggregate"]),
  hostname: z.string().nullable(),
  found: z.boolean(),
  record: SingleDomainOutputSchema.nullable(),
  aggregate: AggregateOutputSchema.nullable(),
});

export async function handleDomainStats({ hostname }: { hostname?: string }) {
  return instrumentTool("domain_stats", async () => {
    if (hostname) {
      const record = await getDomainRecord(hostname);
      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No domain-db record for ${hostname}.`,
            },
          ],
          structuredContent: {
            mode: "single" as const,
            hostname,
            found: false,
            record: null,
            aggregate: null,
          },
        };
      }
      return {
        content: [{ type: "text" as const, text: formatDomainRecord(record) }],
        structuredContent: {
          mode: "single" as const,
          hostname,
          found: true,
          record: summarizeDomainRecord(record),
          aggregate: null,
        },
      };
    }

    // Aggregate mode — operator-triggered, bounded off-hot-path scan.
    const { records, truncated } = await enumerateDomains();
    const aggregate = aggregateDomainStats(records, truncated);
    return {
      content: [
        { type: "text" as const, text: formatDomainAggregate(aggregate) },
      ],
      structuredContent: {
        mode: "aggregate" as const,
        hostname: null,
        found: aggregate.domains_tracked > 0,
        record: null,
        aggregate,
      },
    };
  });
}

const LanguageSchema = z
  .string()
  .optional()
  .describe(
    "BCP-47 language code (e.g. 'en', 'de') or 'all' for all languages. Omit to use the SearXNG instance default.",
  );

export function registerTools(server: McpServer): void {
  server.tool(
    "search",
    "Search the web via the local SearXNG instance with reranking. Fetches a wider result pool from SearXNG, reranks by relevance using a local ML model, then returns the top results. Results are cached for 1 hour. Blocked domains are filtered out; boosted domains are surfaced higher. Prefer this over the built-in WebSearch tool.",
    {
      query: z.string().describe("Search query"),
      num_results: z.coerce
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of results to return (default 5, max 20)"),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe(
          "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency; most useful for research queries where one phrasing may miss relevant results.",
        ),
      language: LanguageSchema,
    },
    handleSearch,
  );

  server.tool(
    "search_and_fetch",
    "Search the web, rerank results, then fetch the full content of the top result(s). GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Results and fetched pages are cached. Blocked domains are filtered. Returns the result list plus clean markdown of the fetched pages.",
    {
      query: z.string().describe("Search query"),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(3)
        .default(1)
        .describe(
          "Number of top results to fetch full content for (default 1, max 3)",
        ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe(
          "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency.",
        ),
      language: LanguageSchema,
    },
    handleSearchAndFetch,
  );

  server.tool(
    "fetch_url",
    "Fetch and extract readable content from any URL. GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Returns clean markdown where possible. Content truncated to 8000 characters. Results cached for 24 hours. Blocked domains are refused.",
    {
      url: z.string().url().describe("URL to fetch and extract content from"),
      domain_profile: DomainProfileSchema,
    },
    handleFetchUrl,
  );

  server.tool(
    "search_and_summarize",
    "Search, rerank, fetch top results, then synthesize a summary with citations using a local LLM (qwen3:14b). Returns a structured answer with source attribution. Falls back to raw fetched content if Ollama is unavailable. Best for deep research where you want pre-digested synthesis rather than raw pages.",
    {
      query: z.string().describe("Research query to search for and summarize"),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe(
          "Number of top results to fetch and synthesize (default 3, max 5)",
        ),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe("Use query expansion before searching (default: off)"),
      language: LanguageSchema,
    },
    handleSearchAndSummarize,
  );

  server.tool(
    "crawl_site",
    "Crawl a site and return a manifest of pages with titles and snippets. " +
      "Full page content is cached — call fetch_url on any page URL for the full text. " +
      "Strategy: Firecrawl (JS rendering) → sitemap-first → BFS (if enabled).",
    {
      url: z.string().url().describe("Base URL to crawl"),
      max_pages: z.coerce
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum pages to crawl (default 20, max 100)"),
      same_domain_only: z.coerce
        .boolean()
        .default(true)
        .describe("Restrict crawl to the same domain (default true)"),
      include_path: z
        .string()
        .optional()
        .describe("Only include URLs matching this path prefix (e.g. '/docs')"),
      exclude_path: z
        .string()
        .optional()
        .describe("Exclude URLs matching this path prefix (e.g. '/blog')"),
    },
    handleCrawlSite,
  );

  server.tool(
    "clear_cache",
    "Purge the search and/or fetch result cache. Useful when researching fast-moving topics where cached results from the past hour may be stale.",
    {
      target: z
        .enum(["search", "fetch", "crawl", "all"])
        .default("all")
        .describe(
          "Which cache to clear: search results, fetched pages, crawl manifests, or all (default all)",
        ),
    },
    handleClearCache,
  );

  server.registerTool(
    "domain_stats",
    {
      title: "Domain capability stats",
      description:
        "Read the searxng-mcp domain capability database — what it has learned about hosts from fetches: per-tier success rates (tier1-3 cascade, tier4 wayback, github fast path), llms.txt/robots presence, metadata reachability, and search appearances. Provide `hostname` for one domain's record, or omit it for an aggregate across all tracked domains (per-tier success rates, worst failing domains, seen-but-never-fetched count). Read-only. Aggregate mode reports `truncated: true` if the internal scan cap is hit.",
      inputSchema: {
        hostname: z
          .string()
          .optional()
          .describe(
            "Hostname or URL to look up (e.g. 'docs.anthropic.com'). Omit for an aggregate over all tracked domains.",
          ),
      },
      outputSchema: DomainStatsOutputSchema,
    },
    handleDomainStats,
  );
}
