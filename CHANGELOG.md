# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Test coverage tooling** — `@vitest/coverage-v8` wired into `vitest.config.ts` (`pnpm coverage`), with a threshold floor set from the measured post-coverage baseline (70% statements, 63% branches, 73% functions, 72% lines). CI runs it on the Node 22 leg.
- **Test coverage for previously-untested files** — `src/tiers/github.ts`, `src/hister.ts`, `src/cli/dump-domain.ts`, and `src/config.ts` had zero test coverage; all four now have dedicated suites (35 new tests, on top of the 22 added for the GitHub routing fix above). `src/cli/dump-domain.ts`'s top-level CLI invocation is now guarded behind an `import.meta.url` entrypoint check so `main()` can be imported and unit-tested without triggering `process.exit`.
- **tier4 (wayback) domain-db telemetry** — `tier_stats_30d` now tracks a `tier4` slot (`attempts`/`ok`/`fail`/`last_fail_reason`/`window_start_ms`, same shape as tier1-3), recorded via the existing `runTier` instrumentation path when `WAYBACK_ENABLED=true`. Previously wayback hits weren't recorded anywhere in the domain-db, so a domain served entirely via wayback showed 0% success across all tracked tiers. `dump-domain` prints the tier4 summary alongside tier1-3. Bumps `DomainRecord.schema_version` 2->3 — existing cached records are treated as stale and rebuilt fresh on next write, same migration approach as the 1->2 bump.
- **Metadata side-channel fetch now tracked** — `fetchRawHtmlForMetadata` (used for JSON-LD/og:title sampling) success/failure is recorded under `capabilities.metadata_fetch`, separate from `tier_stats_30d` since it's a different concern (metadata sampling, not full-content delivery). Answers "is this domain reachable at all" without cross-referencing tier stats and post-extract sampling separately.
- **`search` tool now records domain appearances** — the domain-db previously only saw traffic from `fetch_url`/`crawl_site`/`search_and_fetch`/`search_and_summarize`; the plain `search` tool never touched it (`handleSearch` never calls `fetchPage`). `searxSearch()` now fires a lightweight, deduplicated-by-domain, fire-and-forget `capabilities.seen_in_search` write (count + last-seen timestamp) on every return path, including cache hits. No fetch is performed and the write is never awaited on the response path.

### Fixed
- **GitHub fast path now handles `raw.githubusercontent.com` and `api.github.com` directly** — previously the fast path only matched `hostname === "github.com"`, so a direct raw-file or API URL fell through to the generic tier1-3 HTML-scraping cascade and failed 100% of the time (Firecrawl/Crawl4AI can't usefully render a raw text file or bare JSON response). These were the two highest-volume, 100%-failure domains in a month of tracked usage (`raw.githubusercontent.com`: 28 attempts/0 successes, `api.github.com`: 6/0). `githubFetch` now dispatches on hostname: raw URLs are fetched as-is, `api.github.com` responses are decoded (base64 `content` fields) or pretty-printed as JSON, and `github.com/*/blob/*` still rewrites to a raw-content fetch as before.

### Security
- **Dependency audit clean** — bumped `undici` to `7.28.0` (patches `GHSA-35p6-xmwp-9g52`, `GHSA-g8m3-5g58-fq7m`, `GHSA-p88m-4jfj-68fv`, `GHSA-pr7r-676h-xcf6`, `GHSA-wgpf-jwqj-8h8p`) and the `@opentelemetry/sdk-node`/`exporter-metrics-otlp-http`/`exporter-trace-otlp-http` trio to `0.220.0` (pulls in `@opentelemetry/core@2.9.0`, `@grpc/grpc-js`, and `protobufjs` patched versions). `pnpm audit --prod` clean: 0 findings (was 17: 7 high, 8 moderate, 2 low).

## [3.12.0] - 2026-06-07

### Added
- **Hister fast path** — when `HISTER_URL` and `HISTER_TOKEN` are set, `fetch_url` queries the Hister browsing-history index before invoking the tier cascade. Uses the Hister MCP endpoint (`POST /mcp → tools/call → search`) with a `url:` field filter for exact-URL matching. On a hit, content is served directly and written to the Dragonfly hot cache (24h TTL), skipping Firecrawl/Crawl4AI entirely. Provides access to login-walled and JS-heavy pages already rendered by the browser extension, and avoids re-fetching stable indexed content. Inserted after the Kiwix fast path and before the robots.txt gate. Feature is fully gated — zero overhead when env vars are unset.
- **New env vars:** `HISTER_URL` (Hister instance base URL), `HISTER_TOKEN` (bearer token for MCP endpoint access).

### Security
- Hister `url:` filter value wrapped in quotes to prevent query-injection ambiguity from special characters in URLs (`hister.ts`). Belt-and-suspenders: JSON encoding handles embedded characters and the URL equality check on the response prevents serving wrong-page content regardless.
- Non-timeout errors in `histerFetch` now logged to stderr for ops visibility — auth failures and Hister-down events no longer silently degrade.

## [3.11.0] - 2026-06-05

### Added
- **`crawl_site` tool** — crawls a site and returns a manifest (URL, title, 200-char snippet per page). Full page content is written to the existing fetch cache so follow-up `fetch_url` calls hit the cache at 100%. Three-phase strategy cascade: Firecrawl `/v2/crawl` (JS rendering, async polling) → sitemap-first (robots.txt `Sitemap:` directives + `/sitemap.xml` + `/sitemap_index.xml`, batch-fetched via existing tier cascade) → BFS via JSDOM (opt-in, `CRAWL_BFS_ENABLED=true`). Manifest is cached under `crawl:` keys with configurable TTL (`CRAWL_MANIFEST_TTL_SECONDS`, default 6h).
- **`clear_cache "crawl"` target** — purges `crawl:*` manifest cache keys. `clear_cache "all"` now also clears crawl manifests.
- **New env vars:** `CRAWL_MANIFEST_TTL_SECONDS` (default 21600), `CRAWL_MAX_PAGES_DEFAULT` (default 20), `CRAWL_BFS_ENABLED` (default false), `CRAWL_BFS_MAX_DEPTH` (default 3), `FIRECRAWL_CRAWL_POLL_INTERVAL_MS` (default 2000), `FIRECRAWL_CRAWL_MAX_WAIT_MS` (default 120000).
- **`fast-xml-parser` dependency** — pure-JS XML parser for sitemap parsing (no native bindings).

### Security
- **`crawlSite()` SSRF guard** — `assertPublicUrl(url)` now called at entry before any strategy dispatch; previously the user-supplied URL could reach Firecrawl (delegation SSRF) or robots.txt fetch (process SSRF) without validation.
- **Bounded response reads** — `fetchSitemapXml` and BFS raw HTML re-fetch now use `readBoundedText()` (2MB cap) instead of unbounded `res.text()`.
- **Firecrawl job ID validation** — job ID validated against `/^[a-zA-Z0-9_-]{1,128}$/` before URL path interpolation.
- **`assertPublicUrl` blocklist expanded** — `169.254.0.0/16` (RFC 3927 link-local / AWS IMDS) and `100.64.0.0/10` (RFC 6598 CGNAT) added.

## [3.10.0] - 2026-06-05

### Added
- **HTTP/SSE transport** — set `SEARXNG_MCP_TRANSPORT=http` to run as a shared HTTP server instead of stdio. `SEARXNG_MCP_PORT` (default `3001`) and `SEARXNG_MCP_HOST` (default `127.0.0.1`) control the listen address. Intended for multi-client agent deployments; stdio remains the default for single-client use.
- **`docker/adblock-proxy/`** — new HTTP forward proxy service using `@ghostery/adblocker` (EasyList + EasyPrivacy). Blocks plain-HTTP ad/tracker requests for tiers 2 and 3. HTTPS CONNECT is tunneled without MITM. Configure with `ADBLOCK_PROXY_URL=http://adblock-proxy:8118`. See `docker/adblock-proxy/README.md` for the two-sidecar architecture overview.

### Changed
- **Tier cascade refactored** — `Tier` interface (`src/tiers/types.ts`) with `name`, `slot`, and `fetch()`. `getTiers(url)` in `src/routing.ts` returns `{ active, skipped }` in a single call. `fetch.ts` cascade loop replaced with a clean `for…of` over active tiers. No behavior change.
- **`ADBLOCK_PROXY_URL`** — when set, tier-3 raw Node fetches are routed through an undici `ProxyAgent`; tier-2 Crawl4AI requests include `proxy_config: { server: URL }` in the API request body.
- **HTTP transport session handling** — stateful mode (`sessionIdGenerator: () => crypto.randomUUID()`) to prevent message ID collisions across concurrent clients.

## [3.9.0] - 2026-06-05

### Added
- **Onboarding docs** — `docker-compose.example.yml` (minimal cache-only stack) and `docker-compose.full.yml` (all optional services: Firecrawl, Crawl4AI, Ollama, Reranker, Kiwix, NATS) added for quick setup.
- **`CONTRIBUTING.md`** — prerequisites, setup, test/lint/typecheck, commit conventions, PR process.
- **GitHub issue templates** — bug report and feature request templates under `.github/ISSUE_TEMPLATE/`.
- **Adblock sidecar docs** — `docker/puppeteer-adblock/README.md` documents the patch mechanism, failure modes, build/use instructions, and SHA pin update procedure.

### Changed
- **`CACHE_URL`** is now the canonical cache backend env var; `VALKEY_URL` and `REDIS_URL` are accepted as backward-compatible aliases. Works with Redis, Valkey, and Dragonfly.
- **Wayback Machine tier** — fetched content is now prefixed with `> [via Wayback Machine, archived YYYY-MM-DD]` provenance header. Archive date is parsed from the CDX API timestamp.
- **llms-full.txt cache** — full document body is now stored in Valkey (TTL: `FETCH_CACHE_TTL_SECONDS`) to survive process restarts. In-process L1 cache capped at 10MB.
- **Domain record writes** — replaced in-process per-hostname Promise queue with atomic WATCH/MULTI/EXEC via `cacheAtomicUpdate`. Correct under multiple process instances sharing the same Valkey backend.
- **Adblock sidecar** — logs wrapped `puppeteer-service` version on startup.

### Fixed
- `assertPublicUrl` (`src/fetch-utils.ts`) — added inline comment documenting that `http://` is intentionally permitted.
- `_clearWriteLocksForTests` test stub removed from production export (`src/domain-db.ts`).

### Security
- `src/tiers/wayback.ts` — `closest.url` from CDX API now validated to `https://web.archive.org/` origin before fetch (F-01).

## [3.8.0] - 2026-06-05

### Added
- **Kiwix fast path** — when `KIWIX_URL` is set, fetch requests for Wikipedia (`en.wikipedia.org`), Stack Overflow (`stackoverflow.com`), and Arch Wiki (`wiki.archlinux.org`) are intercepted before the Firecrawl/Crawl4AI cascade and served from the local Kiwix ZIM archive. Eliminates the 100% tier-1 failure rate for `en.wikipedia.org`. Feature is fully gated by the `KIWIX_URL` env var — zero overhead when unset.

## [3.7.0] - 2026-05-18

### Added
- **`language` parameter** on `search`, `search_and_fetch`, and `search_and_summarize` tools. Accepts a BCP-47 language code (e.g. `en`, `de`) or `all`. Omitting it preserves the SearXNG instance default.
- **PDF routing**: `.pdf` URLs are now detected (`isPdfUrl`) and routed directly to Crawl4AI (tier 2), bypassing Firecrawl which cannot extract PDF text. `rawFetch` also throws a descriptive error if it receives `application/pdf` content instead of silently returning binary noise.
- **Wayback Machine tier-4** (opt-in): when `WAYBACK_ENABLED=true`, pages that fail all three tiers are looked up in the Wayback Machine CDX API and fetched from the most recent snapshot. Results get an `[Archived]` title prefix. Disabled by default — no outbound archive.org traffic unless opted in.
- **Test coverage**: added `tests/tools.test.ts`, `tests/ollama.test.ts`, and `tests/tiers/{firecrawl,crawl4ai,raw,wayback}.test.ts`; expanded `tests/search.test.ts`. Coverage up from ~57% to ~80%+ by line count.

### Changed
- `tools.ts` handler closures extracted into named exported functions (`handleSearch`, `handleSearchAndFetch`, `handleSearchAndSummarize`, `handleFetchUrl`, `handleClearCache`) for testability. `registerTools` behavior unchanged.
- Adblock sidecar (`docker/puppeteer-adblock/init-adblock.js`) now guards against double-load via `NODE_OPTIONS` inheritance. Eliminates ~1.5s duplicate filter-list fetch on container start. **Requires container rebuild**: `docker compose -f ~/docker/firecrawl-simple/docker-compose.yml up -d --build firecrawl-puppeteer`.

## [3.6.0] - 2026-05-18

### Changed
- NATS client migrated from `nats` v2 (deprecated) to `@nats-io/nats-core` + `@nats-io/transport-node` v3. No behavior change; addresses install-time deprecation warning. Lazy-import discipline preserved — packages are not loaded unless `NATS_URL` is set.
- `tier_stats_30d` now actually implements a 30-day window (was cumulative in v3.5.0). Stale failures no longer haunt domains that have since recovered. Schema bumped to v2; v1 records are discarded on read and rebuild from new fetches (typically <24h of normal traffic). `pnpm dump-domain` output now shows per-tier success rate and days until window reset.
- Refactored `src/fetch.ts` from 601 lines to 296 by extracting tier-specific handlers into `src/tiers/{firecrawl,crawl4ai,raw,github}.ts`. Shared primitives moved to `src/fetch-utils.ts`. Pure code-move; no behavior change. Eases future per-tier modifications.

### Security
- `fetchRawHtmlForMetadata` now calls `assertPublicUrl()` before fetching — parity with the SSRF-08 guard already present on `rawFetch`. No behavior change for normal usage; protects against future callers with internal URLs.

## [3.5.0] - 2026-05-17

### Added
- **Adblock sidecar** — new `docker/puppeteer-adblock/` directory ships a Dockerfile + `init-adblock.js` that layers `@ghostery/adblocker-puppeteer` (EasyList + EasyPrivacy by default) on top of the upstream `trieve/puppeteer-service-ts:v0.0.6` puppeteer service used by Firecrawl. Base image pinned by SHA256 digest (security check DC-01). The init script is loaded via `NODE_OPTIONS=--require` and monkey-patches `puppeteer.launch()` to wrap every new page with the blocker — no fork of the upstream `api.ts` needed. Configurable via `ADBLOCK_DISABLE=true`, `ADBLOCK_FILTERS_URL=<csv>`, and `ADBLOCK_REFRESH_HOURS=<n>`. Filter lists rebuild on the configured cadence (default 168 h). The firecrawl-simple `docker-compose.yml` already points the `firecrawl-puppeteer` service at this build context — `docker compose up -d --build firecrawl-puppeteer` rebuilds and rolls.
- **Data-driven tier routing** — before kicking off the fetch cascade, `src/routing.ts` reads each domain's `tier_stats_30d` and skips any tier whose success rate is below 30% over at least 10 attempts. Operator override via the new `tier_skip` key in `domains.json` (e.g. `{"unihertz.com": ["tier1"]}`) forces a skip regardless of stats. Cold-start domains (<10 attempts) keep the default cascade. Each skip emits `searxng.fetch.tier.skipped` with `reason: low_success_rate` or `operator_override` and increments the `searxng_fetch_total{outcome=skipped}` counter.
- **Per-domain capability database** — `src/domain-db.ts` records what searxng-mcp learns about each domain on every fetch: tier-1/2/3 attempt counts, robots.txt presence and our allowed-status, llms-full.txt presence and size, and JSON-LD / og:title sampling counts. Records live in Valkey under `domain:<hostname>` (90-day TTL, schema_version: 1). Concurrent writes for the same hostname are serialized through an in-process write queue so the tier-attempt, robots-probe, and post-extract-sample recorders that fire in parallel during one fetch don't clobber each other. New `pnpm dump-domain <hostname>` CLI pretty-prints the record for operator inspection.
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

### Security
- `rawFetch` now enforces `assertPublicUrl()` internally as a defensive guard — all current callers go through `fetchPage` which guards, but the export was a footgun (audit finding L1 / SSRF-08).
- Redirect-block error message no longer echoes the `Location` header back to the MCP caller — a misconfigured redirect to an internal address would have surfaced the target URL (audit finding L2 / OE-02).
- HTML body reads in `rawFetch` and the new `fetchRawHtmlForMetadata` are now bounded at 2 MB via a streaming reader, matching the existing `robots.ts` cap. Prevents JSDOM-amplified memory hazards on large pages (audit finding L3 / IV-14).
- `NATS_CREDS` env var now actually authenticates via `credsAuthenticator(readFileSync(...))` instead of the previous no-op assignment. Both `node:fs` and `credsAuthenticator` stay inside the existing lazy-import block (audit finding L4).

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

[Unreleased]: https://github.com/TadMSTR/searxng-mcp/compare/v3.8.0...HEAD
[3.8.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.7.0...v3.8.0
[3.7.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.6.0...v3.7.0
[3.6.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.2.1...v3.3.0
[3.2.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.2...v3.1.0
[3.0.2]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.2.0...v3.0.0
[2.2.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/TadMSTR/searxng-mcp/releases/tag/v1.0.0
