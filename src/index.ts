#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Redis as Valkey } from "iovalkey";
import { createHash } from "node:crypto";
import { readFileSync, watchFile } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8081";
const FIRECRAWL_URL = process.env.FIRECRAWL_URL ?? "http://localhost:3002";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6381";
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS ?? "3600", 10);
const FETCH_CACHE_TTL_SECONDS = parseInt(process.env.FETCH_CACHE_TTL_SECONDS ?? "86400", 10);

// --- Domain filtering ---

interface DomainProfile {
  boost?: string[];
  block?: string[];
}

interface DomainConfig {
  boost: string[];
  block: string[];
  profiles: Record<string, DomainProfile>;
}

const BOOST_FACTOR = 1.5;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAINS_PATH = resolve(__dirname, "../../domains.json");

let domainConfig: DomainConfig = { boost: [], block: [], profiles: {} };

function loadDomainConfig(): void {
  try {
    const raw = readFileSync(DOMAINS_PATH, "utf-8");
    domainConfig = JSON.parse(raw) as DomainConfig;
    domainConfig.boost ??= [];
    domainConfig.block ??= [];
    domainConfig.profiles ??= {};
  } catch {
    // File missing or malformed — use empty config, no filtering applied
  }
}

loadDomainConfig();
// Hot-reload: re-read domains.json whenever it changes without restarting the MCP server
watchFile(DOMAINS_PATH, { interval: 5000 }, loadDomainConfig);

function getBlockList(profile?: string): string[] {
  const base = domainConfig.block;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].block ?? [])];
}

function getBoostList(profile?: string): string[] {
  const base = domainConfig.boost;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].boost ?? [])];
}

function urlMatchesDomain(url: string, pattern: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const pathname = new URL(url).pathname;
    // Pattern may be "domain.com" or "domain.com/path/prefix"
    if (pattern.includes("/")) {
      const [patDomain, ...patParts] = pattern.split("/");
      const patPath = "/" + patParts.join("/");
      return (hostname === patDomain || hostname.endsWith("." + patDomain)) &&
        pathname.startsWith(patPath);
    }
    return hostname === pattern || hostname.endsWith("." + pattern);
  } catch {
    return false;
  }
}

function applyDomainFilters(
  results: SearxResult[],
  profile?: string
): SearxResult[] {
  const blockList = getBlockList(profile);
  const boostList = getBoostList(profile);

  // Remove blocked domains
  const filtered = results.filter(
    (r) => !blockList.some((pat) => urlMatchesDomain(r.url, pat))
  );

  // Stable sort: boosted domains float to the top, order within each group preserved
  const boosted = filtered.filter((r) =>
    boostList.some((pat) => urlMatchesDomain(r.url, pat))
  );
  const normal = filtered.filter(
    (r) => !boostList.some((pat) => urlMatchesDomain(r.url, pat))
  );

  return [...boosted, ...normal];
}

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

// --- Cache ---

let valkey: Valkey | null = null;

async function getValkey(): Promise<Valkey | null> {
  if (valkey !== null) return valkey;
  try {
    const client = new Valkey(VALKEY_URL, { lazyConnect: true, enableReadyCheck: false });
    client.on("error", () => {
      // Silently disconnect on error — caching is best-effort
      valkey = null;
    });
    await client.connect();
    valkey = client;
    return valkey;
  } catch {
    return null;
  }
}

function searchCacheKey(query: string, category: string, timeRange?: string): string {
  const raw = `${query}|${category}|${timeRange ?? ""}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

function fetchCacheKey(url: string): string {
  return `fetch:${createHash("sha256").update(url).digest("hex")}`;
}

async function cacheGet(key: string): Promise<string | null> {
  try {
    const client = await getValkey();
    if (!client) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: string, ttl: number): Promise<void> {
  try {
    const client = await getValkey();
    if (!client) return;
    await client.set(key, value, "EX", ttl);
  } catch {
    // Best-effort — never throw
  }
}

async function cacheClear(pattern: string): Promise<number> {
  try {
    const client = await getValkey();
    if (!client) return 0;
    const keys = await client.keys(pattern);
    if (keys.length === 0) return 0;
    await client.del(keys);
    return keys.length;
  } catch {
    return 0;
  }
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
    /^::1$/,
    /^0:0:0:0:0:0:0:1$/,
    /^fd[0-9a-f]{2}:/i,
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
  timeRange?: string,
  domainProfile?: string
): Promise<SearxResult[]> {
  // Check cache first
  const key = searchCacheKey(query, category, timeRange);
  const cached = await cacheGet(key);
  if (cached) {
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
  const raw = data.results.slice(0, fetchCount);

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  await cacheSet(key, JSON.stringify(raw), CACHE_TTL_SECONDS);

  return applyDomainFilters(raw, domainProfile);
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

// --- GitHub ---

interface GitHubReadmeResponse {
  content: string;
  name: string;
  html_url: string;
}

async function githubFetch(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo] or [owner, repo, "blob"|"tree", branch, ...path]

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "searxng-mcp",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  if (parts.length >= 4 && parts[2] === "blob") {
    // Rewrite blob URL to raw content
    const [owner, repo, , branch, ...filePath] = parts;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    const rawHeaders: Record<string, string> = { "User-Agent": "searxng-mcp" };
    if (GITHUB_TOKEN) rawHeaders["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(rawUrl, {
      headers: rawHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub raw fetch error: ${res.status} ${res.statusText}`);
    const text = (await res.text()).slice(0, maxChars);
    const fileName = filePath[filePath.length - 1] ?? url;
    return { title: fileName, url: rawUrl, text };
  }

  // Repo root or tree — fetch README via GitHub API
  const [owner, repo] = parts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64").toString("utf-8").slice(0, maxChars);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}

// --- Firecrawl ---

async function firecrawlScrape(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string }> {
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

// --- Page fetcher (routes GitHub URLs to GitHub API, others to Firecrawl) ---

async function fetchPage(
  url: string,
  maxChars = 8000,
  domainProfile?: string
): Promise<{ title: string; url: string; text: string }> {
  assertPublicUrl(url);

  // Refuse to fetch blocked domains
  const blockList = getBlockList(domainProfile);
  if (blockList.some((pat) => urlMatchesDomain(url, pat))) {
    throw new Error(`Domain is blocked by domain filter configuration`);
  }

  // Check fetch cache
  const key = fetchCacheKey(url);
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as { title: string; url: string; text: string };
    } catch {
      // Corrupted cache entry — fall through to live fetch
    }
  }

  const { hostname } = new URL(url);
  const result = hostname === "github.com"
    ? await githubFetch(url, maxChars)
    : await firecrawlScrape(url, maxChars);

  await cacheSet(key, JSON.stringify(result), FETCH_CACHE_TTL_SECONDS);

  return result;
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
  version: "2.1.0",
});

const DomainProfileSchema = z
  .string()
  .optional()
  .describe("Named domain profile to apply: 'homelab', 'dev', or omit for default filters");

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
  },
  async ({ query, num_results, category, time_range, domain_profile }) => {
    const raw = await searxSearch(query, category, num_results, time_range, domain_profile);
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
  },
  async ({ query, category, time_range, fetch_count, domain_profile }) => {
    const raw = await searxSearch(query, category, 5, time_range, domain_profile);
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

const transport = new StdioServerTransport();
await server.connect(transport);
