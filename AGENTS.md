# AGENTS.md — searxng-mcp

MCP server for private web search via a self-hosted SearXNG instance. Reranks results with a local ML model, fetches full-page content via a four-tier cascade (Firecrawl → Crawl4AI → raw HTTP → Wayback Machine opt-in), and optionally expands queries and synthesizes summaries via Ollama.

## What it does

Exposes five MCP tools:

- **`search`** — queries SearXNG, reranks results with a local ML model, returns top N structured results
- **`search_and_fetch`** — same as `search` but also fetches full content of the top result(s) via the fetch cascade
- **`search_and_summarize`** — search, fetch, then synthesize a summary with citations via Ollama (default `qwen3:14b`, override with `OLLAMA_SUMMARIZE_MODEL`)
- **`fetch_url`** — fetch and extract readable markdown from any public URL; GitHub URLs use the GitHub API
- **`clear_cache`** — purge the Valkey result cache (search, fetch, or both)

## Structure

```
src/
  index.ts        # Entry point — creates MCP server, registers tools
  tools.ts        # Tool definitions (schemas + handlers)
  search.ts       # SearXNG client
  fetch.ts        # Fetch orchestrator: robots gate, tier cascade, caching, post-extract
  fetch-utils.ts  # Shared primitives: USER_AGENT, assertPublicUrl, readBoundedText, TierResult
  tiers/          # Tier handlers (one file per tier)
    firecrawl.ts  # Tier 1: Firecrawl JS-rendering scrape
    crawl4ai.ts   # Tier 2: Crawl4AI headless fetch + Readability comparison
    raw.ts        # Tier 3: raw HTTP + Readability; fetchRawHtmlForMetadata for post-extract
    wayback.ts    # Tier 4: Wayback Machine CDX lookup + rawFetch (opt-in, WAYBACK_ENABLED)
    github.ts     # GitHub blob/README API fetch
    index.ts      # Barrel re-export
  reranker.ts     # Jina-compatible reranker client + recency weighting
  ollama.ts       # Ollama client (query expansion + summarization)
  cache.ts        # Valkey/Redis caching layer
  domains.ts      # Domain boost/block filtering + profiles
  config.ts       # Environment variable configuration
  types.ts        # Shared type definitions
tests/
  *.test.ts       # Vitest unit tests (211 tests across 22 files)
```

## Dependencies

Required services:

| Service | Env var | Purpose |
|---|---|---|
| SearXNG | `SEARXNG_URL` | Meta-search engine |
| Firecrawl | `FIRECRAWL_URL` | JS-aware page scraping (tier 1) |

Optional services (server degrades gracefully without these):

| Service | Env var | Purpose |
|---|---|---|
| Reranker | `RERANKER_URL` | ML relevance reranking |
| Crawl4AI | `CRAWL4AI_URL` | Fetch fallback for bot-blocked pages (tier 2) |
| Valkey/Redis | `VALKEY_URL` | Result caching |
| Ollama | `OLLAMA_URL` | Query expansion + summarization |
| Wayback Machine | `WAYBACK_ENABLED=true` | Archived snapshot fallback (tier 4, opt-in) |

## Build and run

```bash
pnpm install
pnpm build        # tsc → build/
node build/src/index.js
```

Transport: stdio (MCP standard).

## Testing

```bash
pnpm test         # vitest run --typecheck
```

## URL safety

`fetch_url` and `search_and_fetch` block requests to private/internal IP ranges (localhost, RFC1918, link-local, IPv6 private). Redirects to internal addresses are also blocked. Do not remove these checks — they prevent SSRF against internal services.

## Git workflow

Branch before editing — do not commit directly to `main`.
