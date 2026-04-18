---
tier: showcase
promoted: null
---

# AGENTS.md — searxng-mcp

MCP server that wraps a self-hosted SearXNG instance with optional reranking and full-page fetching via Firecrawl.

## What it does

Exposes three MCP tools:

- **`search`** — queries SearXNG, reranks results with a local ML model, returns top N structured results (title, URL, snippet, source engine, date)
- **`search_and_fetch`** — same as `search` but also fetches and extracts the full text of the top result via Firecrawl
- **`fetch_url`** — fetches and extracts readable markdown from any public URL via Firecrawl

## Structure

```
src/
  index.ts     # All server logic — tools, SearXNG/Firecrawl/reranker clients, URL safety
tsconfig.json
package.json
```

## Dependencies

Requires three local services:

| Service | Default URL | Purpose |
|---|---|---|
| SearXNG | `http://localhost:8081` | Meta-search engine |
| Firecrawl | `http://localhost:3002` | JS-aware page scraping |
| Reranker | `http://localhost:8787` | ML relevance reranking |

Reranking is optional — if the reranker is unavailable, results fall back to SearXNG's native order.

## Build and run

```bash
pnpm install
pnpm run build       # tsc → build/
node build/index.js
```

Transport: stdio (MCP standard).

## Wiring into a Claude config

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/searxng-mcp/build/index.js"]
    }
  }
}
```

## URL safety

`fetch_url` and `search_and_fetch` block requests to private/internal IP ranges (localhost, RFC1918, link-local). Do not remove this check — it prevents SSRF against internal services.

## Git workflow

Branch before editing — do not commit directly to `main`.
