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
const OLLAMA_URL = process.env.OLLAMA_URL ?? "";
const EXPAND_QUERIES_DEFAULT = process.env.EXPAND_QUERIES === "true";
const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? null;

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

// --- Ollama query expansion ---

interface OllamaGenerateResponse {
  response: string;
}

interface OllamaChatMessage {
  role: string;
  content: string;
}

interface OllamaChatResponse {
  message: OllamaChatMessage;
}

async function expandQuery(query: string): Promise<string[]> {
  if (!OLLAMA_URL) return [];
  const prompt =
    `Generate 2-3 search query variants for the query below. ` +
    `Output ONLY the variant queries, one per line. No numbering, no explanations, no extra text.\n\n` +
    `Original query: ${query}\n\n` +
    `Variant types:\n` +
    `- Technical rephrasing: use precise technical terms\n` +
    `- Product/specific: include product names or version numbers if applicable\n` +
    `- Community: how someone would phrase it in a forum or community\n\n` +
    `Output 2 or 3 variants only:`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:4b",
        prompt,
        stream: false,
        options: { think: false },
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data = (await res.json()) as OllamaGenerateResponse;
    return data.response
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== query)
      .slice(0, 3);
  } catch {
    // Timeout, connection refused, or any error — fall back to original query
    return [];
  }
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

async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string
): Promise<SearxResult[]> {
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
  if (!res.ok) throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as SearxResponse;
  return data.results.slice(0, fetchCount);
}

async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean
): Promise<SearxResult[]> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Check cache first (keyed on original query — expansion results are not cached separately)
  const key = searchCacheKey(query, category, timeRange);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
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

  if (shouldExpand) {
    // Run original query + expanded variants in parallel, merge, deduplicate by URL
    const [variants, originalResults] = await Promise.all([
      expandQuery(query),
      searxSearchSingle(query, category, fetchCount, timeRange),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) => searxSearchSingle(v, category, fetchCount, timeRange))
    );

    // Merge: original results first, then variant results; deduplicate by URL
    const seen = new Set<string>();
    const merged: SearxResult[] = [];
    for (const r of originalResults) {
      if (!seen.has(r.url)) { seen.add(r.url); merged.push(r); }
    }
    for (const settled of variantResults) {
      if (settled.status === "fulfilled") {
        for (const r of settled.value) {
          if (!seen.has(r.url)) { seen.add(r.url); merged.push(r); }
        }
      }
    }

    // Cache only the original query results (not the expanded pool)
    await cacheSet(key, JSON.stringify(originalResults), CACHE_TTL_SECONDS);

    return applyDomainFilters(merged, domainProfile);
  }

  // Non-expanded path
  const raw = await searxSearchSingle(query, category, fetchCount, timeRange);

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

// --- Crawl4AI fetch (second-tier fallback) ---

async function crawl4aiFetch(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string } | null> {
  if (!CRAWL4AI_URL) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const crawlHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const crawl4aiToken = process.env.CRAWL4AI_API_TOKEN;
    if (crawl4aiToken) crawlHeaders["Authorization"] = `Bearer ${crawl4aiToken}`;
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      body: JSON.stringify({ urls: [url] }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;

    // Synchronous response — results returned directly
    if (Array.isArray(data.results) && data.results.length > 0) {
      const result = data.results[0] as Record<string, unknown>;
      const md = result.markdown as Record<string, string> | null;
      const text = (md?.raw_markdown ?? "").slice(0, maxChars);
      if (!text) return null;
      return { title: url, url, text };
    }

    // Asynchronous response — poll for completion
    if (typeof data.task_id === "string") {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) return null;
      return await pollCrawl4aiTask(data.task_id, url, maxChars, controller.signal);
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  maxChars: number,
  signal: AbortSignal
): Promise<{ title: string; url: string; text: string } | null> {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (signal.aborted) return null;

    try {
      const resp = await fetch(`${CRAWL4AI_URL}/task/${taskId}`, { signal });
      if (!resp.ok) return null;

      const data = await resp.json() as Record<string, unknown>;
      if (data.status === "completed") {
        const result = data.result as Record<string, unknown> | null;
        const md = result?.markdown as Record<string, string> | null;
        const text = (md?.raw_markdown ?? "").slice(0, maxChars);
        return text ? { title: url, url, text } : null;
      }
      if (data.status === "failed") return null;
    } catch {
      return null;
    }
  }

  return null;
}

// --- Raw HTTP fetch (third-tier fallback) ---

async function rawFetch(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; searxng-mcp/1.0)" },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Redirect blocked: ${res.status} → ${res.headers.get("location")}`);
  }
  if (!res.ok) throw new Error(`Raw fetch error: ${res.status} ${res.statusText}`);

  const text = (await res.text()).slice(0, maxChars);
  return { title: url, url, text };
}

// --- Page fetcher (routes GitHub URLs to GitHub API, others through fetch cascade) ---

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

  let result: { title: string; url: string; text: string };
  if (hostname === "github.com") {
    result = await githubFetch(url, maxChars);
  } else {
    // Tier 1: Firecrawl
    let fetched: { title: string; url: string; text: string } | null = null;
    try {
      fetched = await firecrawlScrape(url, maxChars);
      if (!fetched?.text) fetched = null; // treat empty content as failure (bot-block, challenge pages)
    } catch {
      fetched = null;
    }

    // Tier 2: Crawl4AI (skipped if CRAWL4AI_URL not set)
    if (!fetched) {
      fetched = await crawl4aiFetch(url, maxChars);
    }

    // Tier 3: Raw HTTP fetch
    result = fetched ?? await rawFetch(url, maxChars);
  }

  await cacheSet(key, JSON.stringify(result), FETCH_CACHE_TTL_SECONDS);

  return result;
}

// --- Ollama summarization ---

interface Citation {
  url: string;
  title: string;
  key_facts: string[];
}

interface SummaryResult {
  summary: string;
  citations: Citation[];
}

async function summarizePages(
  query: string,
  pages: Array<{ title: string; url: string; text: string }>
): Promise<SummaryResult> {
  if (!OLLAMA_URL) return { summary: "", citations: [] };
  if (pages.length === 0) {
    return { summary: "No content to summarize.", citations: [] };
  }

  const MAX_CHARS_PER_PAGE = 4000;
  const pageBlocks = pages
    .map((p, i) =>
      `[Source ${i + 1}] ${p.title}\nURL: ${p.url}\n\n${p.text.slice(0, MAX_CHARS_PER_PAGE)}`
    )
    .join("\n\n---\n\n");

  const prompt =
    `You are a research assistant. Synthesize the sources below to answer the query.\n\n` +
    `Query: ${query}\n\n` +
    `Sources:\n${pageBlocks}\n\n` +
    `Respond with JSON only, no markdown fences, matching this exact schema:\n` +
    `{"summary":"<synthesized answer>","citations":[{"url":"<url>","title":"<title>","key_facts":["<fact>"]}]}\n` +
    `Include only sources that contributed to the answer. key_facts: 1-3 short phrases per source.`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:14b",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { think: false },
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data = (await res.json()) as OllamaChatResponse;
    const raw = (data.message.content.match(/\{[\s\S]*\}/) ?? [data.message.content])[0];
    const parsed = JSON.parse(raw) as SummaryResult;
    return {
      summary: parsed.summary ?? "",
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    };
  } catch {
    // Ollama unavailable, timeout, or parse error — return null to signal fallback
    return { summary: "", citations: [] };
  }
}

function formatSummaryResult(result: SummaryResult): string {
  if (!result.summary) return "";
  const citationText = result.citations
    .map((c) => {
      const facts = c.key_facts.map((f) => `     - ${f}`).join("\n");
      return `  - ${c.title}\n    URL: ${c.url}\n${facts}`;
    })
    .join("\n\n");
  return `## Summary\n\n${result.summary}\n\n## Sources\n\n${citationText}`;
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
  version: "3.0.0",
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

const transport = new StdioServerTransport();
await server.connect(transport);
