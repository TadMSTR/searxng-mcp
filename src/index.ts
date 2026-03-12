#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEARXNG_URL = "http://localhost:8081";

const CategorySchema = z
  .enum(["general", "news", "it", "science"])
  .default("general");

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

async function searxSearch(
  query: string,
  category: string,
  numResults: number
): Promise<SearxResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: category,
    pageno: "1",
  });

  const res = await fetch(`${SEARXNG_URL}/search?${params}`);
  if (!res.ok) {
    throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as SearxResponse;
  return data.results.slice(0, numResults);
}

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

function stripHtml(html: string): string {
  // Remove scripts and styles entirely
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Replace block-level elements with newlines
  text = text.replace(/<\/?(p|br|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function fetchAndExtract(
  url: string
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; searxng-mcp/1.0)" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Fetch error: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const text = stripHtml(html).slice(0, 8000);

  return { title, url, text };
}

const server = new McpServer({
  name: "searxng-mcp",
  version: "1.0.0",
});

server.tool(
  "search",
  "Search the web via the local SearXNG instance. Returns structured results with title, URL, snippet, source engine, and publication date where available. Prefer this over built-in web search.",
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
  },
  async ({ query, num_results, category }) => {
    const results = await searxSearch(query, category, num_results);
    return { content: [{ type: "text", text: formatResults(results) }] };
  }
);

server.tool(
  "search_and_fetch",
  "Search the web and fetch the full text of the top result. Use when a snippet is not enough and you need the full article or page content.",
  {
    query: z.string().describe("Search query"),
    category: CategorySchema.describe(
      "Search category: general, news, it, or science (default general)"
    ),
  },
  async ({ query, category }) => {
    const results = await searxSearch(query, category, 5);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const searchText = formatResults(results);
    const topUrl = results[0].url;
    let fetchedSection = "";

    try {
      const fetched = await fetchAndExtract(topUrl);
      fetchedSection = `\n\n--- Full content: ${fetched.title} ---\n${fetched.text}`;
    } catch (e) {
      fetchedSection = `\n\n--- Could not fetch top result: ${e instanceof Error ? e.message : String(e)} ---`;
    }

    return { content: [{ type: "text", text: searchText + fetchedSection }] };
  }
);

server.tool(
  "fetch_url",
  "Fetch and extract readable text from any URL. Strips HTML tags and returns title plus content (truncated to 8000 characters). Useful for reading articles linked in search results.",
  {
    url: z.string().url().describe("URL to fetch and extract text from"),
  },
  async ({ url }) => {
    const { title, url: fetchedUrl, text } = await fetchAndExtract(url);
    const output = [`Title: ${title}`, `URL: ${fetchedUrl}`, "", text].join(
      "\n"
    );
    return { content: [{ type: "text", text: output }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
