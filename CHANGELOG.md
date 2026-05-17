# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [3.5.0] - 2026-MM-DD

### Added
- **llms.txt fast path** — for whitelisted documentation domains (`docs.anthropic.com`, `docs.openai.com`, `docs.stripe.com`, `docs.crawl4ai.com`, `docs.firecrawl.dev`, `docs.cursor.com`), `fetchPage` first tries `<origin>/llms-full.txt` and extracts the matching page section before invoking any tier. The probe outcome (present/absent) is cached in Valkey for 24 h / 7 d respectively; the large body itself is held in-process for the lifetime of the MCP process (Anthropic's file is ~76 MB, well over what makes sense to round-trip through Valkey on every request). Domains and section matching configurable via the new `llms_txt` array in `domains.json`.
- **Observability** — opt-in OpenTelemetry traces and metrics. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the server emits per-tool, per-tier, and per-stage spans (`tool.<name>`, `searxng_request`, `expand_query`, `rerank`, `fetch`, `tier1_firecrawl`, `tier2_crawl4ai`, `tier3_rawfetch`, `post_extract`, `summarize_llm`) plus counters and histograms (`searxng_search_total`, `searxng_search_duration_seconds`, `searxng_fetch_total{tier, outcome}`, `searxng_fetch_duration_seconds`, `searxng_cache_total`, `searxng_errors_total`). All OTel packages are lazy-loaded — no runtime cost when the env var is unset.
- **NATS event publishing** — opt-in via `NATS_URL`. Fire-and-forget core-NATS publishes on subjects `searxng.search.requested`, `searxng.search.completed`, `searxng.fetch.requested`, `searxng.fetch.tier.miss`, `searxng.fetch.tier.skipped`, `searxng.fetch.completed`, `searxng.cache.hit`, `searxng.cache.miss`, `searxng.error`. Each envelope carries `request_id` and (when OTel is active) `trace_id`, so subscribers can correlate events with traces. Subject prefix configurable via `NATS_SUBJECT_PREFIX`.
- **Request context** — AsyncLocalStorage-backed `request_id` propagation across every tool invocation, so a single tool call's fetches, cache lookups, and emitted events all share one id.
- JSON-LD Article post-extraction — when a tier-1/2/3 fetch returns raw HTML containing a Schema.org `Article`, `NewsArticle`, `BlogPosting`, or `TechArticle` block, `headline` and `articleBody` are extracted and used in preference to chrome-only text. Walks `@graph` arrays; size-capped JSON parse (1 MB) with try/catch.
- Title cascade — new `extractTitle()` helper applies `og:title` → `twitter:title` → `<title>` (with publisher-suffix stripping) → first `<h1>` → URL fallback when post-extraction runs.
- Tier-2 Readability comparison — when Crawl4AI returns content, JSDOM+Readability now also runs over `result.html`; preferred when its text is longer than Crawl4AI's markdown (or unconditionally when Crawl4AI returns <500 chars).
- robots.txt compliance — pre-fetch check using the `robots-parser` package; per-origin result cached 24 h in Valkey under `robots:<origin>`. Disallowed fetches throw `RobotsDisallowedError` and log `skipped_robots url=… reason=…`.
- Honest `User-Agent` — `searxng-mcp/3.5.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)` now sent on tier-3 raw fetches and GitHub API/raw requests.
- Firecrawl scrape requests now ask for both `markdown` and `html` so the JSON-LD/title post-extraction pass runs on tier-1 results too.

### Changed
- Tier handlers internally return an optional `html` field used by the post-extraction pipeline. The persisted cache payload remains `{ title, url, text }` (HTML is not cached).

## [3.4.0] - 2026-05-17

### Added
- `OLLAMA_API_KEY` env var support — when set, adds `Authorization: Bearer <key>` to Ollama requests in `expandQuery` and `summarizePages`. No behavior change when unset.
- `OLLAMA_EXPAND_MODEL` env var (default `qwen3:4b`) — overrides the model used by `expandQuery` without a rebuild.
- `OLLAMA_SUMMARIZE_MODEL` env var (default `qwen3:14b`) — overrides the model used by `summarizePages` without a rebuild. To use in scoped-mcp, add these to the env block of the relevant manifest.
- Tier-success logging to PM2 error log — each `fetchPage` call now logs `tier1 miss`, `tier2 hit/miss`, or `tier3 fallback` lines (stderr, `key=value` format) for fetch utilization analysis.
- `@mozilla/readability` + `jsdom` for clean article extraction in tier-3 (`rawFetch`). Non-article pages (SPAs, search results) fall back to raw HTML slice as before.
- Crawl4AI `fit_markdown` support — `search_and_summarize` now requests noise-filtered content from Crawl4AI; other callers continue to use `raw_markdown`.
- Crawl4AI title extraction — result title is now pulled from `metadata.title` instead of defaulting to the URL.

### Fixed
- Fetch cache truncation bug: `search_and_summarize` (which fetches at 4000 chars) could cache a truncated result that later `fetch_url` calls received. Pages are now always fetched and cached at 8000 chars; the caller's `maxChars` is applied on read.
- Valkey error handler now calls `client.disconnect()` before nulling the reference, preventing stale TCP connection accumulation on repeated Valkey drops.
- Tighten `pnpm.overrides` to resolve transitive CVEs in `@modelcontextprotocol/sdk` deps (`fast-uri`, `hono`, `ip-address`).

### Changed
- `cacheClear` now uses `SCAN` instead of `KEYS` for pattern-based cache invalidation — non-blocking on large keyspaces.

## [3.3.0] - 2026-04-19

### Added
- npm publishing via `@tadmstr/searxng-mcp` — installable with `npx @tadmstr/searxng-mcp`
- `bin` field in package.json for CLI entry point
- `repository` field in package.json linking to GitHub
- Release workflow publishes to npm with `--provenance` attestation on every version tag

### Changed
- Package name changed from `searxng-mcp` to `@tadmstr/searxng-mcp` (org-scoped)
- GitHub Actions SHA pins upgraded to current major versions (checkout v6, setup-node v6, upload-artifact v7, download-artifact v8)
- `@modelcontextprotocol/sdk` updated to 1.29.0; `pnpm.overrides` added for vulnerable transitive deps (`path-to-regexp`, `hono`, `@hono/node-server`)

### Removed
- Unused `BOOST_FACTOR` constant from `src/domains.ts`

## [3.2.1] - 2026-04-19

### Added
- GitHub Actions CI workflow — Node.js 20/22 matrix, type-check, Biome lint, Vitest tests, `pnpm audit --prod` (SHA-pinned actions)
- GitHub Actions release workflow — tag-triggered, builds + tests + `pnpm pack`, creates GitHub Release with tarball attached
- Biome linter (`biome.json`) — single-binary TypeScript linter and formatter; `pnpm lint` / `pnpm lint:fix` scripts
- Security section in README — consolidates SSRF/URL safety, redirect protection (v3.1.0 feature, previously undocumented in README), dependency auditing, credential handling, input validation

### Changed
- `package.json` — added `packageManager` (pnpm@10.30.3), `engines` (node >=20), `files` (clean tarball scope) fields
- README — Claude Code, CI, and License badges in header; Node.js prerequisite updated from 22+ to 20+; provenance note linking to homelab-agent
- AGENTS.md — full rewrite to reflect current 5-tool / 9-module architecture (was stale: 3 tools, single-file structure)

### Fixed
- `src/domains.ts`, `src/reranker.ts`, `src/config.ts`, `src/fetch.ts` — `Number.isNaN` instead of global `isNaN`, template literals, literal key access, unused variable prefix

## [3.2.0] - 2026-04-07

### Added
- Recency weighting in reranker — blends `publishedDate`-based exponential decay score
  with the cross-encoder relevance score (90-day decay constant, weight 0.15 by default).
  Surfaces fresher results within relevance-close clusters without overriding large
  relevance gaps. Configurable via `RERANK_RECENCY_WEIGHT` env var; set to `0` to disable.
  Skipped automatically when `time_range` is set (pool is already date-filtered).

### Changed
- Reranker now requests scores for the full result pool rather than only the final topN,
  enabling post-score re-ordering across all candidates.

## [3.1.0] - 2026-04-07

### Added
- Crawl4AI fetch adapter as second-tier fallback in the fetch cascade (`CRAWL4AI_URL` env var) — uses `markdown.raw_markdown` for clean content extraction on JS-heavy or Firecrawl-failing pages; skipped silently if `CRAWL4AI_URL` is not set
- Raw HTTP fetch as third-tier fallback — ensures `fetch_url` never fails silently when both Firecrawl and Crawl4AI are unavailable
- `CRAWL4AI_API_TOKEN` env var — optional Bearer token for Crawl4AI instances with API token protection

### Fixed
- `search`, `search_and_fetch`, `search_and_summarize`: `expand` parameter coercion switched to `z.coerce.boolean()` — fixes `MCP error -32602: Expected boolean, received string` when MCP serialization coerces `true` to `"true"`
- Fetch cascade falls through to Crawl4AI on empty Firecrawl response — Firecrawl returns `success: true` with empty content on bot-blocked pages rather than throwing; now treated as a soft failure

### Security
- `fetch_url` now correctly blocks IPv6 private-range addresses in bracket notation — `::1`, ULA (`fc00::/7`), and link-local (`fe80::/10`) were not matched because `URL.hostname` returns brackets (e.g., `[::1]`) which the prior regexes didn't account for
- Block HTTP redirects in `rawFetch()` — prevents SSRF bypass via redirect chains to internal addresses
- Validate `task_id` format before use in Crawl4AI poll URL — prevents path traversal

## [3.0.2] - 2026-04-04

### Fixed
- `search_and_summarize`: added regex extraction of the JSON object before parsing — qwen3:14b occasionally appends trailing text after the JSON block, causing `JSON.parse` to throw and silently fall back on every call

## [3.0.1] - 2026-04-04

### Fixed
- `search_and_summarize`: increased summarization timeout from 15s to 45s — qwen3:14b over an HTTPS proxy requires ~17–35s depending on content length; 15s was reliably too short
- `search_and_summarize`: removed `format: "json"` from the Ollama chat request — grammar-constrained generation with qwen3 causes the request to hang indefinitely; the model follows JSON instructions from the prompt without it

## [3.0.0] - 2026-04-04

### Added
- `search_and_summarize` tool — searches, fetches top results, then summarizes via Ollama qwen3:14b; returns a structured `## Summary` block with a synthesized answer and a `## Sources` section (url, title, key_facts per source)
- 45-second summarization timeout with graceful fallback to raw fetch output when Ollama is unavailable or times out

### Security
- Removed hardcoded personal `OLLAMA_URL` default from public repo; `OLLAMA_URL` now defaults to empty string — `expand` and `search_and_summarize` features are call-gated and return a descriptive error when the env var is not set

## [2.2.0] - 2026-04-04

### Added
- `expand` parameter on `search` and `search_and_fetch` — when `true`, rewrites the query via Ollama qwen3:4b to improve recall before sending to SearXNG
- `EXPAND_QUERIES` environment variable — set to `true` to enable expansion globally without passing `expand=true` per call
- `OLLAMA_URL` environment variable — configures the Ollama API base URL for query expansion

### Security
- Deleted core dump files from repo history and added `core` pattern to `.gitignore`

## [2.1.0] - 2026-04-04

### Added
- Valkey result caching via `iovalkey` — search results cached for 1 hour, fetched pages for 24 hours
- `clear_cache` tool — purge search cache, fetch cache, or both; useful when researching fast-moving topics where cached results are stale
- Domain filtering via `domains.json` — global boost and block lists applied to all search results
- `domain_profile` parameter on `search`, `search_and_fetch`, and `fetch_url` — apply a named profile per query to adjust boost/block behavior
- Two built-in domain profiles: `homelab` (surfaces self-hosted/Linux docs) and `dev` (surfaces Stack Overflow, MDN, npm docs)
- Hot-reload of `domains.json` every 5 seconds — domain config changes apply without restarting the MCP server

### Security
- Blocked IPv6 loopback addresses (`::1`) in `assertPublicUrl` to prevent SSRF bypass via IPv6
- Committed `pnpm-lock.yaml` for reproducible builds

## [2.0.0] - 2026-03-20

### Added
- `search_and_fetch` tool — searches, reranks, then fetches full content of the top 1–3 results in a single call
- `fetch_url` tool — fetch and extract readable content from any URL; GitHub URLs use the GitHub API, all others use Firecrawl
- Native GitHub URL handling via the GitHub API (repos, files, issues, PRs) without requiring Firecrawl
- `time_range` parameter on `search` and `search_and_fetch` — filter results to `day`, `week`, `month`, or `year`
- `fetch_count` parameter on `search_and_fetch` — fetch full content for 1–3 top results (default 1)
- All service URLs (`SEARXNG_URL`, `FIRECRAWL_URL`, `RERANKER_URL`) configurable via environment variables
- `AGENTS.md` for AI agent orientation

### Changed
- Numeric tool parameters use `z.coerce.number()` — accepts both string and number inputs to handle MCP serialization quirks

### Security
- Applied findings from initial security audit (SSRF protections, input validation)

## [1.0.0] - 2026-03-12

### Added
- `search` tool — web search via self-hosted SearXNG with ML reranking via a local reranker service
- Firecrawl integration for full-page content extraction (JS-rendered pages, clean markdown output)
- Result reranking using a local ML model with fallback to raw SearXNG ordering when the reranker is unavailable
- Category filtering: `general`, `news`, `it`, `science`

[Unreleased]: https://github.com/TadMSTR/searxng-mcp/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.2...v3.1.0
[3.0.2]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.2.0...v3.0.0
[2.2.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/TadMSTR/searxng-mcp/releases/tag/v1.0.0
