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

## Container image

Published to GHCR on every release tag:

```bash
docker pull ghcr.io/tadmstr/searxng-mcp:latest
```

```bash
docker run -d --name searxng-mcp -p 127.0.0.1:3001:3001 \
  -e SEARXNG_URL=http://searxng:8080 \
  -e SEARXNG_MCP_TRANSPORT=http \
  -e SEARXNG_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/tadmstr/searxng-mcp:latest
```

Available tags, `linux/amd64`:

| Tag | Moves | Use it when |
|-----|-------|-------------|
| `v3.24.0` and `3.24.0` | never | You want a specific release pinned. Both spellings are published — the git tag carries the `v`, the conventional Docker tag does not. |
| `3.24` | to the newest stable `3.24.x` | You want patches automatically but not minor bumps. |
| `latest` | to the newest stable release | You want the current release and can tolerate minor bumps. |

Prereleases (`v3.24.0-rc1`) publish their exact tags only — they never move
`3.24` or `latest`.

The image runs as uid 1000 and is not root. Every published image has passed
the same smoke assertions CI runs — `/health` answers unauthenticated, `/mcp`
returns 401 without a bearer token and 200 with the right one — executed
against that exact image before it was pushed. Build provenance is attested
and pushed to the registry alongside it:

```bash
gh attestation verify oci://ghcr.io/tadmstr/searxng-mcp:latest --owner TadMSTR
```

### Verifying the registry copy directly

The attestation is also in GHCR, but **GHCR does not implement the OCI
referrers API** — `GET /v2/<name>/referrers/<digest>` returns
`404 MANIFEST_UNKNOWN` even for a digest that exists and has an attestation.

That 404 is easy to read as "there is no attestation". It is not. GHCR uses the
spec's *fallback tag* scheme instead, publishing the referrers index under a tag
named `sha256-<digest>`:

```bash
REPO=tadmstr/searxng-mcp
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull&service=ghcr.io" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Resolve the tag to a digest...
DIGEST=$(curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
  "https://ghcr.io/v2/$REPO/manifests/latest" \
  | tr -d '\r' | awk -F': ' '/[Dd]ocker-[Cc]ontent-[Dd]igest/{print $2}')

# ...then read the referrers index from the fallback tag (note ':' -> '-')
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/$REPO/manifests/${DIGEST/:/-}" | python3 -m json.tool
```

which returns an index whose entry carries
`artifactType: application/vnd.dev.sigstore.bundle.v0.3+json` and
`dev.sigstore.bundle.predicateType: https://slsa.dev/provenance/v1`.

`cosign`, `oras` and `crane` implement the fallback and find this without any
of the above. A bare `curl` against `/referrers/` does not, and reports zero —
which is exactly how vikunja#689 came to conclude the attestation was missing.

Verified 2026-09-06 against both published images at v3.25.0 and v3.25.1.

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

## MCP Resources through a proxy

Resources (`config://searxng-mcp`, `stats://domains`) are a separate JSON-RPC surface from
tools — `resources/list` / `resources/read`, not `tools/list` / `tools/call`. A proxy that
re-registers upstream tools on its own server, rather than forwarding the wire protocol
generically, carries the tools through fine and drops Resources without any error — there is
nothing to catch, because the client that dropped them never advertised support in the first
place.

Verified against one such proxy, scoped_mcp 1.14.0: its `mcp_proxy` calls only `list_tools()`
and `call_tool()` on the upstream client and re-registers the results on its own server — there
is no generic forwarding path, and `grep -rln "list_resources\|read_resource"` over its tree
returns zero files. Resources reach direct MCP clients (Claude Code, Claude Desktop, LibreChat)
without issue; they do not reach a client sitting behind that proxy. The seven tools are
unaffected either way.

If you're deploying behind a different proxy, check whether it implements `resources/list` and
`resources/read` before relying on either Resource — a tool-only proxy is a common shape to hit,
not something specific to the proxy above.

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
