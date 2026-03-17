# searxng-mcp

An MCP server for private web search via a self-hosted [SearXNG](https://github.com/searxng/searxng) instance. Results are reranked by a local ML model before being returned, and a Firecrawl instance handles full-page content fetching for JS-rendered sites.

Designed for use with Claude Code and LibreChat agents that need web search without sending queries to a third-party search API.

## Tools

| Tool | Description |
|------|-------------|
| `search` | Search the web via SearXNG with local reranking. Fetches a wider result pool, reranks by relevance, returns top N results. |
| `search_and_fetch` | Search, rerank, then fetch full content of the top result via Firecrawl (handles JS-rendered pages). |
| `fetch_url` | Fetch and extract readable markdown content from any public URL via Firecrawl. Truncated to 8,000 characters. |

## Architecture

```
MCP client (stdio)
      │
      ▼
  searxng-mcp
      ├── search query ──→ SearXNG (port 8081) ──→ raw results
      ├── rerank ─────────→ Reranker (port 8787) ──→ ranked results
      └── fetch_url ──────→ Firecrawl (port 3002) ──→ page markdown
```

All three backing services are expected to be running locally on localhost. The reranker is optional — if unavailable, the server falls back to SearXNG's native result ordering.

## Transport

stdio (compatible with Claude Code MCP plugin and LibreChat `stdio` config).

## Prerequisites

- Node.js 22+
- pnpm (or npm)
- A running [SearXNG](https://github.com/searxng/searxng) instance on port 8081
- A running reranker on port 8787 (optional — falls back gracefully if not available)
- A running [Firecrawl](https://github.com/mendableai/firecrawl) instance on port 3002

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

Any Firecrawl-compatible instance works. The local [firecrawl-simple](https://github.com/mendableai/firecrawl/tree/main/apps/api) deployment is sufficient. Set the `FIRECRAWL_API_KEY` environment variable if your instance requires authentication (defaults to `placeholder-local` for local deployments that skip auth).

## Configuration

The server uses hardcoded localhost addresses by default:

| Service | Default |
|---------|---------|
| SearXNG | `http://localhost:8081` |
| Firecrawl | `http://localhost:3002` |
| Reranker | `http://localhost:8787` |

If your services run on different ports, update the constants at the top of `src/index.ts` and rebuild.

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
      "args": ["/path/to/searxng-mcp/build/src/index.js"]
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
      FIRECRAWL_API_KEY: your-api-key-if-required
```

## Search Categories

The `search` and `search_and_fetch` tools accept a `category` parameter:

| Category | Use for |
|----------|---------|
| `general` | Default — broad web search |
| `news` | Recent news articles |
| `it` | Technical/IT topics |
| `science` | Academic and scientific content |

## URL Safety

The `fetch_url` and `search_and_fetch` tools enforce a URL allowlist — private/internal IP ranges (`10.x`, `192.168.x`, `172.16-31.x`, `localhost`, `127.x`) and non-HTTP protocols are blocked. This prevents the server from being used as an SSRF proxy into your local network.

## License

MIT
