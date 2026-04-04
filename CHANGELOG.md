# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Crawl4AI fetch adapter as second-tier fallback in the fetch cascade (`CRAWL4AI_URL` env var) — uses `markdown.raw_markdown` for clean content extraction on JS-heavy or Firecrawl-failing pages; skipped silently if `CRAWL4AI_URL` is not set
- Raw HTTP fetch as third-tier fallback — ensures fetch never fails silently when both Firecrawl and Crawl4AI are unavailable
- `CRAWL4AI_API_TOKEN` env var — optional Bearer token for Crawl4AI instances with API token protection; included as `Authorization: Bearer <token>` header when set

### Fixed
- `search_and_fetch`, `search_and_summarize`, `search`: `expand` parameter coercion switched to `z.coerce.boolean()` across all three tools — fixes `MCP error -32602: Expected boolean, received string` when MCP serialization layer coerces `true` to `"true"`
- Fetch cascade now falls through to Crawl4AI on empty Firecrawl response — Firecrawl returns `success: true` with empty content on bot-blocked or challenge pages rather than throwing; empty-content check added so Crawl4AI activates on soft failures, not only on exceptions

### Security
- Validate `task_id` format against `^[a-zA-Z0-9_-]+$` before use in `pollCrawl4aiTask` URL path construction — prevents path traversal
- Block HTTP redirects in `rawFetch()` — prevents SSRF bypass via redirect chains to internal addresses

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

[Unreleased]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.2...HEAD
[3.0.2]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.2.0...v3.0.0
[2.2.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TadMSTR/searxng-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TadMSTR/searxng-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/TadMSTR/searxng-mcp/releases/tag/v1.0.0
