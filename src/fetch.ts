import { FIRECRAWL_URL, FIRECRAWL_API_KEY, GITHUB_TOKEN, CRAWL4AI_URL, CRAWL4AI_API_TOKEN, FETCH_CACHE_TTL_SECONDS } from "./config.js";
import type { FirecrawlScrapeResponse, GitHubReadmeResponse } from "./types.js";
import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";

export function assertPublicUrl(url: string): void {
  const { protocol } = new URL(url);
  // Strip IPv6 brackets so patterns like /^::1$/ match [::1] addresses correctly
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
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

async function crawl4aiFetch(
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string } | null> {
  if (!CRAWL4AI_URL) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const crawlHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (CRAWL4AI_API_TOKEN) crawlHeaders["Authorization"] = `Bearer ${CRAWL4AI_API_TOKEN}`;
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

export async function fetchPage(
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
