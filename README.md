# searxng-mcp

An MCP server for private web search via a self-hosted [SearXNG](https://github.com/searxng/searxng) instance. Results are reranked by a local ML model before being returned, and a Firecrawl instance handles full-page content fetching for JS-rendered sites.

Designed for use with Claude Code and LibreChat agents that need web search without sending queries to a third-party search API.

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search` | Search via SearXNG with local reranking. Fetches a wider result pool, reranks by relevance, returns top N. | `query`, `num_results` (1–20), `category`, `time_range` |
| `search_and_fetch` | Search, rerank, then fetch full content of the top result(s) via Firecrawl (handles JS-rendered pages). | `query`, `category`, `time_range`, `fetch_count` (1–3) |
| `fetch_url` | Fetch and extract readable markdown from any public URL. GitHub URLs use the GitHub API; all others use Firecrawl. Truncated to 8,000 characters. | `url` |

### Parameters

**`category`** — `general` (default), `news`, `it`, `science`

**`time_range`** — `day`, `week`, `month`, `year` — limits results by publication date. Omit for all-time results.

**`fetch_count`** — number of top reranked results to fetch full content for (default `1`, max `3`). The 8,000-character content budget is divided evenly across fetched pages.

## Architecture

```
MCP client (stdio)
      │
      ▼
  searxng-mcp
      ├── search query ──→ SearXNG ($SEARXNG_URL)      ──→ raw results
      ├── rerank ─────────→ Reranker ($RERANKER_URL)    ──→ ranked results
      └── fetch content ──→ Firecrawl ($FIRECRAWL_URL)  ──→ page markdown
```

All three backing services are expected to be running and reachable. The reranker is optional — if unavailable, the server falls back to SearXNG's native result ordering.

## Transport

stdio (compatible with Claude Code MCP plugin and LibreChat `stdio` config).

## Prerequisites

- Node.js 22+
- pnpm (or npm)
- A running [SearXNG](https://github.com/searxng/searxng) instance
- A running reranker exposing a Jina-compatible `/v1/rerank` endpoint (optional)
- A running [Firecrawl](https://github.com/mendableai/firecrawl) instance

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

## Configuration

All service URLs are configurable via environment variables. Defaults point to localhost.

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | `http://localhost:8081` | SearXNG instance URL |
| `FIRECRAWL_URL` | `http://localhost:3002` | Firecrawl instance URL |
| `RERANKER_URL` | `http://localhost:8787` | Reranker instance URL |
| `FIRECRAWL_API_KEY` | `placeholder-local` | Firecrawl API key (if required) |
| `GITHUB_TOKEN` | *(unset)* | GitHub personal access token — increases GitHub API rate limit from 60 to 5,000 req/hour |

## Build

```bash
pnpm install
pnpm build
```

Output: `build/src/index.js`

## MCP Client Configuration

### Claude Code (`.mcp.json` or `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/searxng-mcp/build/src/index.js"],
      "env": {
        "SEARXNG_URL": "http://localhost:8081",
        "FIRECRAWL_URL": "http://localhost:3002",
        "RERANKER_URL": "http://localhost:8787",
        "FIRECRAWL_API_KEY": "placeholder-local"
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
      FIRECRAWL_API_KEY: placeholder-local
```

## GitHub URLs

`github.com` URLs are handled natively without Firecrawl:

- **Repo root** (`github.com/owner/repo`) — fetches the README via the GitHub API
- **File blob** (`github.com/owner/repo/blob/branch/path/to/file`) — fetches raw content from `raw.githubusercontent.com`

Unauthenticated requests are rate-limited to 60/hour. Set `GITHUB_TOKEN` to raise this to 5,000/hour.

## URL Safety

The `fetch_url` and `search_and_fetch` tools enforce a URL allowlist — private/internal IP ranges (`10.x`, `192.168.x`, `172.16-31.x`, `localhost`, `127.x`) and non-HTTP protocols are blocked. This prevents the server from being used as an SSRF proxy into your local network.

## License

MIT
