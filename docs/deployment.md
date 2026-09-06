<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Install and deployment

## npm (recommended)

```bash
npm install -g @tadmstr/searxng-mcp
```

Or run directly with `npx`:

```bash
npx @tadmstr/searxng-mcp
```

## From source

```bash
git clone https://github.com/TadMSTR/searxng-mcp.git
cd searxng-mcp
pnpm install
pnpm build
```

Output: `build/src/index.js`

# MCP Client Configuration

## Claude Code (CLI)

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
    "CACHE_URL": "redis://localhost:6379",
    "CACHE_TTL_SECONDS": "3600",
    "FETCH_CACHE_TTL_SECONDS": "86400",
    "EXPAND_QUERIES": "false",
    "CRAWL4AI_URL": "http://localhost:11235"
  }
}'
```

This writes to `~/.claude.json`. Do not add searxng to `~/.claude/settings.json` — that file is not used for MCP env var injection in Claude Code.

## Claude Desktop (`claude_desktop_config.json`)

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
        "CACHE_URL": "redis://localhost:6379",
        "CRAWL4AI_URL": "http://localhost:11235"
      }
    }
  }
}
```

## LibreChat (`librechat.yaml`)

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
      CACHE_URL: redis://localhost:6379
      CRAWL4AI_URL: http://localhost:11235
```

# Transport

**stdio** (default) — compatible with Claude Code MCP plugin and LibreChat `stdio` config.

**HTTP** — set `SEARXNG_MCP_TRANSPORT=http` to run as a shared HTTP/SSE server suitable for multi-client deployments or Docker-based setups. Binds to `SEARXNG_MCP_HOST:SEARXNG_MCP_PORT` (default `127.0.0.1:3001`):

```bash
SEARXNG_MCP_TRANSPORT=http SEARXNG_MCP_PORT=3001 npx @tadmstr/searxng-mcp
```

Register with Claude Code against an HTTP server:

```bash
claude mcp add-json searxng --scope user '{
  "type": "http",
  "url": "http://localhost:3001/mcp"
}'
```

Sessions are keyed by the `Mcp-Session-Id` header, so multiple clients can connect to the same shared process concurrently. Idle sessions are swept after `HTTP_SESSION_IDLE_TIMEOUT_MS` and hard-capped at `HTTP_MAX_SESSIONS` — see [Configuration](configuration.md).

## HTTP transport authentication

The HTTP transport is **unauthenticated by default**, which is safe only because it binds `127.0.0.1` by default. If you change `SEARXNG_MCP_HOST` to anything else — including `0.0.0.0`, which is what running in a container requires — set `SEARXNG_MCP_AUTH_TOKEN` as well:

```bash
SEARXNG_MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

When it is set, every request except `GET /health` must carry the token as an [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) bearer credential:

```
Authorization: Bearer <token>
```

Anything else — no header, a different scheme, a wrong token — gets `401` with `WWW-Authenticate: Bearer` and a JSON-RPC error body. The response is identical in all three cases and never echoes the presented credential. Tokens are compared as SHA-256 digests, so the comparison is constant-time and leaks no length information.

Registering an authenticated server with Claude Code:

```bash
claude mcp add-json searxng --scope user '{
  "type": "http",
  "url": "http://localhost:3001/mcp",
  "headers": {"Authorization": "Bearer <token>"}
}'
```

Leaving the variable unset preserves the previous behaviour exactly, so stdio users and existing loopback-bound HTTP deployments need no change. There is no per-caller authorization model — a single token authenticates *access to the server*, not a particular client identity. On startup, a non-loopback bind with no token logs a warning.

**`GET /health` is deliberately exempt** from the check. It is the container healthcheck and the monitoring liveness probe, it takes no input, and its response (`status`, `cache`, `sessions`) carries no secrets.

**`GET /health`** — unauthenticated liveness probe, localhost-bound alongside the MCP endpoint. Pings Valkey through the bounded cache command timeout (so the check itself can never hang) and returns:

```json
{"status": "ok", "cache": "up", "sessions": 3}
```

or, when the cache backend is unreachable:

```json
{"status": "degraded", "cache": "degraded", "sessions": 3}
```

`sessions` is the live HTTP session count. Useful for sysadmin monitoring to detect a degraded cache from the MCP side without instrumenting the cache backend directly.

---

[← Docs index](index.md) · [Configuration](configuration.md)
