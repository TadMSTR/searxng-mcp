# searxng-mcp

[![Built with Claude Code](https://img.shields.io/badge/Built_with-Claude_Code-6B57FF?logo=claude&logoColor=white)](https://claude.ai/code)
[![CI](https://github.com/TadMSTR/searxng-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TadMSTR/searxng-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/@tadmstr/searxng-mcp)](https://www.npmjs.com/package/@tadmstr/searxng-mcp)

An MCP server for private web search via a self-hosted [SearXNG](https://github.com/searxng/searxng) instance. SearXNG is the only requirement; everything else is optional and layers on top — a local ML model reranks results, a three-tier cascade (Firecrawl, Crawl4AI, in-process raw fetch) retrieves full-page content, and an Ollama instance provides query expansion and LLM-synthesized summaries.

Designed for use with Claude Code and LibreChat agents that need web search without sending queries to a third-party search API.

Built with [Claude Code](https://claude.ai/code) using the multi-agent workflow from [homelab-agent](https://github.com/TadMSTR/homelab-agent) — the same platform that uses searxng-mcp in production for AI-assisted research.

## Quick Start

**A running [SearXNG](https://github.com/searxng/searxng) instance is the only requirement.**
Everything else is optional and improves a specific dimension — see [Prerequisites](docs/configuration.md#prerequisites-and-service-setup).

**SearXNG only** — nothing else deployed:

```bash
SEARXNG_URL=http://localhost:8081 \
  FIRECRAWL_ENABLED=false CACHE_URL= RERANKER_URL= \
  npx @tadmstr/searxng-mcp
```

What works in this configuration: `search` returns ranked results, and `fetch_url` /
`search_and_fetch` return extracted page content via tier 3 (raw HTTP fetch + Readability, wholly
in-process). What does not: semantic reranking (results keep SearXNG's ordering), query expansion
and `search_and_summarize` (no LLM), caching (every call is live), JS-heavy page rendering, and
offline serving.

The startup capability line reports three states per capability, not two:
`on` (self-contained — nothing remote has to work for it to be true), `unverified` (configured,
but this process has never contacted the backend), and `off` (not configured). Nothing probes at
startup, so `unverified` is not a health failure — it's the honest absence of a health claim, not
an error. The command above prints exactly this:

```
capabilities on=tier3 unverified=none off=tier1,tier2,cache,reranker,llm,kiwix,hister,solver,wayback,otel,nats
```

`tier3` is the only thing `on`, because it is the only capability that is true without anything
remote working. `wayback` is `off` until you set `WAYBACK_ENABLED=true` — it is a feature flag,
not a default.

The three overrides are what make it a *clean* minimal run rather than merely a working one.
`FIRECRAWL_URL`, `CACHE_URL` and `RERANKER_URL` all have non-empty defaults, so left alone the
server spends the whole run talking to services that were never deployed — every fetch first
attempts a Firecrawl that is not there and books the failure into the domain capability
database, which then routes around a tier that was never broken, only absent.

`FIRECRAWL_ENABLED=false` is a real kill switch. `CACHE_URL` and `RERANKER_URL` have none, so
the lever is an empty string.

### The compose ladder

Four compose files in [`examples/`](examples/), each a strict superset of the one above it. Start
at the rung that matches what you are willing to run; every rung's header comment states what
works, what does not, and which environment variable moves you up.

| Rung | File | Adds | Containers | RAM | Unlocks |
|---|---|---|---|---|---|
| 1 | [`compose.minimal.yml`](examples/compose.minimal.yml) | SearXNG + searxng-mcp | 2 | ~600 MB | The least you can run |
| 2 | [`compose.crawl4ai.yml`](examples/compose.crawl4ai.yml) | cache, Crawl4AI | 4 | ~6 GB | JS rendering, real caching |
| 3 | [`compose.reranker.yml`](examples/compose.reranker.yml) | reranker | 5 | ~8 GB | Relevance reranking, `min_score` |
| 4 | [`compose.full.yml`](examples/compose.full.yml) | Firecrawl, Ollama, Kiwix, NATS, adblock | 12 | ~24 GB | Summarisation, PDFs, offline corpora |

**Rung 2 is the recommended starting point** — the cache is the single largest latency win, and
Crawl4AI gets you JavaScript rendering for one container instead of Firecrawl's three.

```bash
cd examples
export SEARXNG_SECRET=$(openssl rand -hex 32)
docker compose -f compose.crawl4ai.yml up -d
```

Moving up a rung is `docker compose -f compose.<next>.yml up -d` — all four share a compose
project name, so compose reconciles in place rather than starting a second copy of what you
already had.

**As a container** — published to GHCR on every release:

```bash
docker pull ghcr.io/tadmstr/searxng-mcp:latest
```

Tags, uid, and provenance verification: [Deployment](docs/deployment.md#container-image).

The reranker ships in this repo — `cd docker/reranker && docker compose up`, or pull `ghcr.io/tadmstr/searxng-mcp-reranker`. It is CPU-only, needs no API key, and has the model baked in so there is no cold start. See [`docker/reranker/README.md`](docker/reranker/README.md).

Two adblocking sidecars are also published as images, one per fetch-tier group:

- `ghcr.io/tadmstr/searxng-mcp-adblock-proxy` — ad/tracker filtering for tiers 2 and 3. It is an
  **open forward proxy with no authentication**, so loopback or a private network only — see
  [`docker/adblock-proxy/README.md`](docker/adblock-proxy/README.md) for placement.
- `ghcr.io/tadmstr/searxng-mcp-playwright-adblock` — EasyList/EasyPrivacy filtering for
  Firecrawl v2's renderer (tier 1). This is an **upgrade** of upstream's existing
  `AD_SERVING_DOMAINS` token list, not a new capability — that list still applies underneath. It
  targets the **v2** renderer only; `docker/puppeteer-adblock/` covers v1 and does nothing on a
  v2 deployment. Note `FIRECRAWL_API_VERSION` defaults to **`v1`** in `src/config.ts`, so a stack
  wiring the playwright sidecar must set it to `v2` explicitly or tier-1 adblocking silently does
  nothing — `examples/compose.full.yml` sets it and says why. See
  [`docker/playwright-adblock/README.md`](docker/playwright-adblock/README.md).

For a full local topology including Firecrawl, Crawl4AI, Ollama, Kiwix, the adblock proxy, and NATS, see rung 4 of the ladder above — [`examples/compose.full.yml`](examples/compose.full.yml).

## Tools

| Tool | What it does |
|------|--------------|
| `search` | Search via SearXNG with local ML reranking, plus SearXNG's own direct answers, infoboxes and suggestions. |
| `search_and_fetch` | Search, rerank, then fetch full content of the top result(s) through the fetch cascade. |
| `search_and_summarize` | Search, fetch, then synthesize a cited summary via Ollama. On failure, falls back to raw fetched content led by an explicit `summarization unavailable (<kind>: <detail>)` marker — no marker means a real synthesis. |
| `fetch_url` | Fetch and extract readable markdown from any public URL, via fast paths or the fetch cascade. |
| `crawl_site` | Crawl a site and return a URL/title/snippet manifest. Page content is cached, so follow-up `fetch_url` calls are free. |
| `clear_cache` | Purge the search, fetch or crawl cache. |
| `domain_stats` | Read-only view of the domain capability database — per-tier success rates, as structured output. |

Full parameter reference: [`docs/tools.md`](docs/tools.md).

## Why searxng-mcp?

There are a number of SearXNG MCP servers. Most wrap the search endpoint and stop there. The
differentiators here are in what happens *after* the search:

| | searxng-mcp | Typical SearXNG MCP server |
|---|---|---|
| SearXNG search | yes | yes |
| ML reranking of results | local cross-encoder, reorders by relevance — ships in [`docker/reranker/`](docker/reranker/) | SearXNG's own ordering |
| Full-page content retrieval | three-tier cascade — Firecrawl, Crawl4AI, in-process raw fetch + Readability | none, or a single raw fetch |
| Per-domain routing | domain capability database learns which tier works per domain and skips the ones that do not | none |
| Summarisation | Ollama, with citations back to source URLs | none |
| Site crawling | `crawl_site` — Firecrawl crawl, sitemap fallback, optional BFS | none |
| Caching | persistent, shared across clients (Valkey/Redis) | in-process or none |
| Challenge handling | detection-gated solver tier, plus a Wayback fallback | none |
| Observability | OpenTelemetry traces and metrics, NATS events, structured logs | none |

**Only SearXNG is required.** Everything in the table above degrades gracefully: with nothing
else deployed, `fetch_url` still returns extracted content from the in-process tier 3, and the
startup capability line tells you exactly what's configured, what's configured but not yet
verified, and what's off — see [Quick Start](#quick-start) above.

## Architecture

The fetch cascade, in full. Each stage is optional and skipped cleanly when unconfigured.

```mermaid
flowchart TD
    entry["fetchPage(url)"]
    cache{"Valkey cache hit?"}
    cached["→ return cached { title, url, text }"]
    github{"GitHub host?\ngithub.com · raw · api"}
    gh_fetch["GitHub API / raw.githubusercontent.com / api.github.com\n→ return"]
    llms{"llms.txt domain?"}
    llms_fetch["Probe /llms-full.txt\nextract matching section\n→ return"]
    kiwix{"Kiwix host?\nKIWIX_URL set"}
    kiwix_fetch["Local Kiwix ZIM\nWikipedia · Stack Overflow · Arch Wiki\n→ cache + return"]
    robots["robots.txt pre-check — tiers 1–3\ndisallowed → RobotsDisallowedError (cached 24h)"]
    tier_skip(["Per-domain tier skip\nsuccess rate &lt;30% over ≥10 tries\nor tier_skip operator override"])
    t1["Tier 1 — Firecrawl\n$FIRECRAWL_URL\nserves PDFs under FIRECRAWL_API_VERSION=v2"]
    t2["Tier 2 — Crawl4AI\n$CRAWL4AI_URL · optional\ndirect — no adblock proxy"]
    t3["Tier 3 — Raw HTTP + Readability\nfallback: raw HTML slice\nadblock proxy if $ADBLOCK_PROXY_URL"]
    challenge(["Challenge detected\non this URL, this request?"])
    solver["Solver — Byparr\n$SOLVER_URL · opt-in, SOLVER_ENABLED=true\nSSRF-guarded replay"]
    t4["Tier 4 — Wayback Machine CDX API\narchived snapshot · WAYBACK_ENABLED=true"]
    post["Post-extraction\nJSON-LD Article · title cascade\nog:title → twitter:title → title → h1 → URL"]
    result["→ return { title, url, text }"]

    entry --> cache
    cache -->|hit| cached
    cache -->|miss| github
    github -->|yes| gh_fetch
    github -->|no| llms
    llms -->|yes| llms_fetch
    llms -->|no| kiwix
    kiwix -->|yes| kiwix_fetch
    kiwix -->|no| robots
    robots --> tier_skip
    tier_skip --> t1
    t1 -->|success| post
    t1 -->|"empty / error"| t2
    t2 -->|success| post
    t2 -->|"empty / error"| t3
    t3 -->|success| post
    t3 -->|"empty / error"| challenge
    challenge -->|"yes, SOLVER_ENABLED"| solver
    challenge -->|no| t4
    solver -->|success| post
    solver -->|"miss / disabled"| t4
    t4 -->|success| result
    post --> result

    style entry fill:#ffffff,stroke:#333333,color:#000000
    style cache fill:#ffffff,stroke:#333333,color:#000000
    style cached fill:#ffffff,stroke:#333333,color:#000000
    style github fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style gh_fetch fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style llms fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style llms_fetch fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style kiwix fill:#fff9c4,stroke:#b8860b,color:#000000
    style kiwix_fetch fill:#fff9c4,stroke:#b8860b,color:#000000
    style robots fill:#ffffff,stroke:#333333,color:#000000
    style tier_skip fill:#f5f5f5,stroke:#666666,color:#000000
    style t1 fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style t2 fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style t3 fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style challenge fill:#f5f5f5,stroke:#666666,color:#000000
    style solver fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style t4 fill:#f8cecc,stroke:#a03030,color:#000000
    style post fill:#e1d5e7,stroke:#7a5a8a,color:#000000
    style result fill:#ffffff,stroke:#333333,color:#000000
```

Read the rest — tier semantics, the domain capability database, adblocking, every fast path,
resilience and observability — in [`docs/architecture.md`](docs/architecture.md).

## Documentation

| | |
|---|---|
| [Configuration](docs/configuration.md) | Every environment variable, and setup for each optional backing service. |
| [Tools](docs/tools.md) | Full per-tool parameter reference. |
| [Deployment](docs/deployment.md) | Install, transports, HTTP auth, and MCP client recipes. |
| [Architecture](docs/architecture.md) | Fetch cascade, tier semantics, domain capability database. |
| [Security](docs/security.md) | SSRF, redirects, transport exposure, bounded reads, credentials. |

Index: [`docs/index.md`](docs/index.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, commit conventions, and the PR process.

### Integration tests

A real-Valkey integration suite covering domain-DB concurrency is gated on `VALKEY_TEST_URL` and skipped entirely when it's unset, so a plain `pnpm test` still works with no Valkey present:

```bash
VALKEY_TEST_URL=redis://:<password>@<host>:<port>/<scratch-db> pnpm test
```

Use a **scratch database index** — the suite writes and deletes `domain:*` keys and refuses to run against index `0` or `1` as a safety guard.

## License

MIT
