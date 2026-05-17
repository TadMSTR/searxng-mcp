# searxng-mcp

[![Built with Claude Code](https://img.shields.io/badge/Built_with-Claude_Code-6B57FF?logo=claude&logoColor=white)](https://claude.ai/code)
[![CI](https://github.com/TadMSTR/searxng-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TadMSTR/searxng-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/@tadmstr/searxng-mcp)](https://www.npmjs.com/package/@tadmstr/searxng-mcp)

An MCP server for private web search via a self-hosted [SearXNG](https://github.com/searxng/searxng) instance. Results are reranked by a local ML model, full-page content is fetched via Firecrawl, and an optional Ollama instance provides query expansion and LLM-synthesized summaries.

Designed for use with Claude Code and LibreChat agents that need web search without sending queries to a third-party search API.

Built with [Claude Code](https://claude.ai/code) using the multi-agent workflow from [homelab-agent](https://github.com/TadMSTR/homelab-agent) — the same platform that uses searxng-mcp in production for AI-assisted research.

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search` | Search via SearXNG with local reranking. Fetches a wider result pool, reranks by relevance, returns top N. | `query`, `num_results` (1–20), `category`, `time_range`, `domain_profile`, `expand` |
| `search_and_fetch` | Search, rerank, then fetch full content of the top result(s) using the fetch cascade (Firecrawl → Crawl4AI → raw HTTP). | `query`, `category`, `time_range`, `fetch_count` (1–3), `domain_profile`, `expand` |
| `search_and_summarize` | Search, fetch top results, then synthesize a summary with citations via Ollama (`OLLAMA_SUMMARIZE_MODEL`). Falls back to raw fetched content if Ollama is unavailable. | `query`, `fetch_count` (1–5), `category`, `time_range`, `domain_profile`, `expand` |
| `fetch_url` | Fetch and extract readable markdown from any public URL. GitHub URLs use the GitHub API; all others use the fetch cascade (Firecrawl → Crawl4AI → raw HTTP). Truncated to 8,000 characters. | `url`, `domain_profile` |
| `clear_cache` | Purge the search cache, fetch cache, or both. Useful when researching fast-moving topics where cached results may be stale. | `target` (`search`, `fetch`, `all`) |

### Parameters

**`category`** — `general` (default), `news`, `it`, `science`

**`time_range`** — `day`, `week`, `month`, `year` — limits results by publication date. Omit for all-time results.

**`fetch_count`** — number of top reranked results to fetch full content for (default `1`, max `3` for `search_and_fetch`; default `3`, max `5` for `search_and_summarize`).

**`domain_profile`** — apply a named domain filter profile: `homelab` (surfaces self-hosted/Linux docs) or `dev` (surfaces Stack Overflow, MDN, npm). Omit for default filters.

**`expand`** — when `true`, rewrites the query via Ollama (`OLLAMA_EXPAND_MODEL`) before searching to improve recall. Requires `OLLAMA_URL`. Defaults to the `EXPAND_QUERIES` env var value.

## Architecture

```
MCP client (stdio)
      │
      ▼
  searxng-mcp ──────────────→ Valkey ($VALKEY_URL)        → result cache (search 1h, fetch 24h)
      │
      ├── expand (optional) →  Ollama ($OLLAMA_URL)        → rewritten query (qwen3:4b)
      ├── search ───────────→ SearXNG ($SEARXNG_URL)      → raw results
      ├── rerank ───────────→ Reranker ($RERANKER_URL)    → ranked results
      │                       (fallback: SearXNG order if reranker unavailable)
      ├── fetch content ────┬→ GitHub API (github.com)    → markdown
      │                     ├→ Firecrawl ($FIRECRAWL_URL) → page markdown (tier 1)
      │                     ├→ Crawl4AI ($CRAWL4AI_URL)  → page markdown (tier 2, optional)
      │                     └→ Raw HTTP + Readability     → page markdown (tier 3 fallback)
      └── summarize (opt.) →  Ollama ($OLLAMA_URL)        → synthesized summary ($OLLAMA_SUMMARIZE_MODEL)
```

![Fetch routing](assets/fetch-routing.drawio.svg)

SearXNG and Firecrawl are required. Crawl4AI, Valkey, Ollama, and the reranker are optional — the server degrades gracefully when any of these are unavailable.

### llms.txt fast path

For whitelisted documentation domains in `domains.json` (`llms_txt` array), `fetchPage` tries `<origin>/llms-full.txt` first and extracts the section matching the requested URL before invoking any tier. This avoids running puppeteer against well-instrumented docs sites and returns a clean markdown section directly. Cached probe outcomes live in Valkey (`llms:<origin>:full`, 24 h / 7 d for present/absent); the large body is held in-process for the lifetime of the MCP. Default whitelist: `docs.anthropic.com`, `docs.openai.com`, `docs.stripe.com`, `docs.crawl4ai.com`, `docs.firecrawl.dev`, `docs.cursor.com`. Extend by editing `domains.json` — the file is hot-reloaded.

### Fetch quality

After any tier returns content with raw HTML, a post-extraction pass improves title and body quality:

- **JSON-LD Article extraction** — Schema.org `Article` / `NewsArticle` / `BlogPosting` / `TechArticle` blocks supply cleaner `headline` and `articleBody` than tier-1 chrome scraping (size-capped at 1 MB per script tag).
- **Title cascade** — falls back through `og:title` → `twitter:title` → `<title>` (with publisher-suffix stripping) → first `<h1>` → URL.
- **Tier-2 Readability comparison** — when Crawl4AI returns markdown, JSDOM+Readability also runs over its raw HTML and is preferred when its text is longer (or unconditionally when Crawl4AI returns less than 500 chars).

### Observability (opt-in)

Tracing, metrics, and event publishing are entirely opt-in — with none of the env vars below set, the server has zero observability overhead and never loads the OpenTelemetry or NATS packages at runtime.

**OpenTelemetry (traces + metrics)** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector's HTTP endpoint and the server emits:

- Spans (per request): `tool.<name>` → `expand_query`? → `searxng_request` → `rerank` → `fetch` (×N) → `tier1_firecrawl` | `tier2_crawl4ai` | `tier3_rawfetch` → `post_extract`; plus `summarize_llm` for `search_and_summarize`.
- Counters: `searxng_search_total{profile, expand}`, `searxng_fetch_total{tier, outcome}`, `searxng_cache_total{namespace, outcome}`, `searxng_errors_total{stage, error_type}`.
- Histograms: `searxng_search_duration_seconds{profile}`, `searxng_fetch_duration_seconds{tier, outcome}`.

Standard OTEL env vars apply (`OTEL_SERVICE_NAME` defaults to `searxng-mcp`).

**NATS events** — set `NATS_URL` (e.g. `nats://localhost:4222`) and the server publishes a structured event on every search, fetch, cache hit/miss, robots skip, and error. Subjects:

| Subject | When |
|---------|------|
| `searxng.search.requested` | Search tool invoked |
| `searxng.search.completed` | Search returned (with sources, latency, rerank applied) |
| `searxng.fetch.requested` | `fetchPage` called |
| `searxng.fetch.tier.miss` | A tier returned empty or threw |
| `searxng.fetch.tier.skipped` | robots.txt disallowed |
| `searxng.fetch.completed` | Fetch resolved (with `tier_served`, `text_len`, latency) |
| `searxng.cache.hit` / `.miss` | On every Valkey lookup |
| `searxng.error` | Stage-tagged errors |

Each envelope includes `request_id` and (when OTel is enabled) `trace_id` so subscribers can join the two streams. Subject prefix overridable via `NATS_SUBJECT_PREFIX`. Search queries flow through `search.*` events — downstream consumers are responsible for any PII scrubbing.

### Politeness

- **Honest User-Agent** — outbound requests identify as `searxng-mcp/<version> (+https://github.com/TadMSTR/searxng-mcp; personal research)`.
- **robots.txt compliance** — `/robots.txt` is fetched once per origin and cached for 24 hours in Valkey under `robots:<origin>`. Disallowed paths are skipped before any tier runs and logged as `skipped_robots url=… reason=…`.

## Transport

stdio (compatible with Claude Code MCP plugin and LibreChat `stdio` config).

## Prerequisites

- Node.js 20+
- pnpm (or npm)
- A running [SearXNG](https://github.com/searxng/searxng) instance
- A running [Firecrawl](https://github.com/mendableai/firecrawl) instance
- A running reranker exposing a Jina-compatible `/v1/rerank` endpoint (optional)
- A running [Valkey](https://valkey.io/) or Redis-compatible instance (optional, for result caching)
- A running [Ollama](https://ollama.com/) instance with `qwen3:4b` and/or `qwen3:14b` pulled (optional, for query expansion and summarization)

### SearXNG

SearXNG must have JSON output format enabled. In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

### Reranker

The reranker must expose a Jina-compatible `/v1/rerank` endpoint. A lightweight FlashRank wrapper works well — see the [`docker/reranker/`](https://github.com/TadMSTR/homelab-agent/tree/main/docker/reranker) reference in [homelab-agent](https://github.com/TadMSTR/homelab-agent).

### Firecrawl

Any Firecrawl-compatible instance works. The local [firecrawl-simple](https://github.com/mendableai/firecrawl/tree/main/apps/api) deployment is sufficient. Set `FIRECRAWL_API_KEY` if your instance requires authentication (defaults to `placeholder-local` for local deployments that skip auth).

### Crawl4AI

[Crawl4AI](https://github.com/unclecode/crawl4ai) is an optional second-tier fetch fallback used when Firecrawl returns empty content (bot-blocked pages, JS-heavy sites). Set `CRAWL4AI_URL` to enable it. If unset, the cascade skips to raw HTTP fetch.

```bash
docker run -d -p 11235:11235 unclecode/crawl4ai:0.8.6
```

If your instance requires API token authentication, set `CRAWL4AI_API_TOKEN`.

On the `search_and_summarize` path, Crawl4AI requests use `fit_markdown` for noise-filtered content extraction. Other callers (`search_and_fetch`, `fetch_url`) use `raw_markdown`.

### Valkey / Redis

Any Redis-compatible instance. Valkey is recommended. Search results are cached for 1 hour; fetched pages for 24 hours. If unavailable, the server operates without caching.

### Ollama

Required for `expand` and `search_and_summarize`. Pull the required models:

```bash
ollama pull qwen3:4b   # query expansion
ollama pull qwen3:14b  # summarization
```

Set `think: false` behavior is handled automatically — no extra Ollama configuration needed.

## Configuration

All service URLs are configurable via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | `http://localhost:8081` | SearXNG instance URL |
| `FIRECRAWL_URL` | `http://localhost:3002` | Firecrawl instance URL |
| `RERANKER_URL` | `http://localhost:8787` | Reranker instance URL |
| `FIRECRAWL_API_KEY` | `placeholder-local` | Firecrawl API key (if required) |
| `GITHUB_TOKEN` | *(unset)* | GitHub personal access token — increases rate limit from 60 to 5,000 req/hour |
| `OLLAMA_URL` | *(unset)* | Ollama API base URL — required for `expand` and `search_and_summarize` |
| `OLLAMA_API_KEY` | *(unset)* | Bearer token for authenticated Ollama proxies — adds `Authorization: Bearer <key>` header when set |
| `OLLAMA_EXPAND_MODEL` | `qwen3:4b` | Model used by query expansion (`expand` parameter). Override without rebuilding. |
| `OLLAMA_SUMMARIZE_MODEL` | `qwen3:14b` | Model used by `search_and_summarize`. Override without rebuilding. |
| `VALKEY_URL` | `redis://localhost:6381` | Redis-compatible URL — enables result caching. Server degrades gracefully if unavailable. |
| `CACHE_TTL_SECONDS` | `3600` | Search result cache TTL in seconds |
| `FETCH_CACHE_TTL_SECONDS` | `86400` | Fetched page cache TTL in seconds |
| `EXPAND_QUERIES` | `false` | Set to `true` to enable query expansion globally |
| `CRAWL4AI_URL` | *(unset)* | Crawl4AI instance URL — enables second-tier fetch fallback when Firecrawl fails |
| `CRAWL4AI_API_TOKEN` | *(unset)* | Optional Bearer token for Crawl4AI instances with API token protection |

## Install

### npm (recommended)

```bash
npm install -g @tadmstr/searxng-mcp
```

Or run directly with `npx`:

```bash
npx @tadmstr/searxng-mcp
```

### From source

```bash
git clone https://github.com/TadMSTR/searxng-mcp.git
cd searxng-mcp
pnpm install
pnpm build
```

Output: `build/src/index.js`

## MCP Client Configuration

### Claude Code (CLI)

The recommended approach uses `claude mcp add-json` to register the server with full env var support:

```bash
claude mcp add-json searxng --scope user '{
  "command": "npx",
  "args": ["-y", "@tadmstr/searxng-mcp"],
  "env": {
    "SEARXNG_URL": "http://localhost:8081",
    "FIRECRAWL_URL": "http://localhost:3002",
    "RERANKER_URL": "http://localhost:8787",
    "OLLAMA_URL": "http://localhost:11434",
    "VALKEY_URL": "redis://localhost:6379",
    "CACHE_TTL_SECONDS": "3600",
    "FETCH_CACHE_TTL_SECONDS": "86400",
    "EXPAND_QUERIES": "false",
    "CRAWL4AI_URL": "http://localhost:11235"
  }
}'
```

This writes to `~/.claude.json`. Do not add searxng to `~/.claude/settings.json` — that file is not used for MCP env var injection in Claude Code.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "@tadmstr/searxng-mcp"],
      "env": {
        "SEARXNG_URL": "http://localhost:8081",
        "FIRECRAWL_URL": "http://localhost:3002",
        "RERANKER_URL": "http://localhost:8787",
        "OLLAMA_URL": "http://localhost:11434",
        "VALKEY_URL": "redis://localhost:6379",
        "CRAWL4AI_URL": "http://localhost:11235"
      }
    }
  }
}
```

### LibreChat (`librechat.yaml`)

```yaml
mcpServers:
  searxng:
    type: stdio
    command: node
    args:
      - /path/to/searxng-mcp/build/src/index.js
    env:
      SEARXNG_URL: http://localhost:8081
      FIRECRAWL_URL: http://localhost:3002
      RERANKER_URL: http://localhost:8787
      OLLAMA_URL: http://localhost:11434
      VALKEY_URL: redis://localhost:6379
      CRAWL4AI_URL: http://localhost:11235
```

## GitHub URLs

`github.com` URLs are handled natively without Firecrawl:

- **Repo root** (`github.com/owner/repo`) — fetches the README via the GitHub API
- **File blob** (`github.com/owner/repo/blob/branch/path/to/file`) — fetches raw content from `raw.githubusercontent.com`

Unauthenticated requests are rate-limited to 60/hour. Set `GITHUB_TOKEN` to raise this to 5,000/hour.

## Security

### URL safety

The `fetch_url` and `search_and_fetch` tools enforce a URL allowlist — private/internal IP ranges (`10.x`, `192.168.x`, `172.16-31.x`, `localhost`, `127.x`), IPv6 private ranges (`::1`, `fc00::/7`, `fe80::/10`), and non-HTTP protocols are blocked. This prevents the server from being used as an SSRF proxy into your local network.

### Redirect protection

HTTP redirects in raw fetch requests are blocked to prevent SSRF bypass via redirect chains to internal addresses.

### Dependency auditing

CI runs `pnpm audit` on every push. The lockfile (`pnpm-lock.yaml`) is committed for reproducible, auditable builds.

### Credential handling

No credentials are stored or logged by the server. API keys (`FIRECRAWL_API_KEY`, `GITHUB_TOKEN`, `CRAWL4AI_API_TOKEN`) are read from environment variables and used only in outbound requests to their respective services.

### Input validation

Environment variables are validated at startup — `RERANK_RECENCY_WEIGHT` warns on NaN, negative, or >1.0 values. Numeric tool parameters use `z.coerce.number()` with range constraints.

## License

MIT
