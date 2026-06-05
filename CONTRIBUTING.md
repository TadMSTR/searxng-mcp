# Contributing to searxng-mcp

## Prerequisites

- Node.js 20+
- pnpm 10.30.3+

## Setup

```bash
git clone https://github.com/TadMSTR/searxng-mcp.git
cd searxng-mcp
pnpm install
pnpm build
```

## Running tests

```bash
pnpm test
```

## Linting

```bash
pnpm lint        # Biome — check and report
pnpm lint:fix    # Biome — auto-fix
```

## Type check

```bash
pnpm exec tsc --noEmit
```

## Running locally

The minimum required env var is `SEARXNG_URL` pointing at any SearXNG instance.
All other services are optional — the server degrades gracefully when they are absent.

```bash
SEARXNG_URL=http://localhost:8081 node build/src/index.js
```

To run against a local SearXNG instance quickly:

```bash
docker run -d -p 8081:8080 searxng/searxng
SEARXNG_URL=http://localhost:8081 node build/src/index.js
```

See `docker-compose.example.yml` for a minimal stack including a cache backend,
and `docker-compose.full.yml` for the full topology.

## Commit conventions

Use a `type/scope` prefix:

| Type | When |
|------|------|
| `feat` | New capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `chore` | Build, deps, tooling |
| `security` | Security fix |
| `refactor` | Code restructure, no behavior change |
| `test` | Test additions or fixes |

Examples: `feat(kiwix): add zim routing`, `fix(domain-db): atomic write race`

## PR process

1. Fork and create a branch (`feat/<slug>` or `fix/<slug>`)
2. Make your changes — `pnpm build && pnpm test && pnpm lint` must all pass
3. Open a PR against `main`
4. CI runs automatically; merge requires CI green
