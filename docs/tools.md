<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search` | Search via SearXNG with local reranking. Fetches a wider result pool, reranks by relevance, returns top N. SearXNG's native direct answers, infoboxes, spelling corrections, and related suggestions are surfaced above the list and in `structuredContent`. | `query`, `num_results` (1–20), `category`, `time_range`, `domain_profile`, `expand`, `language`, `engines`, `site`, `min_score` |
| `search_and_fetch` | Search, rerank, then fetch full content of the top result(s) using the fetch cascade (Firecrawl → Crawl4AI → raw HTTP). | `query`, `category`, `time_range`, `fetch_count` (1–3), `domain_profile`, `expand`, `language`, `engines`, `site`, `min_score` |
| `search_and_summarize` | Search, fetch top results, then synthesize a summary with citations via Ollama (`OLLAMA_SUMMARIZE_MODEL`). Falls back to raw fetched content if Ollama is unavailable — the fallback announces itself with a leading `--- summarization unavailable (<kind>: <detail>) — the text below is raw fetched pages, NOT a synthesis ---` marker, so a caller can always tell a synthesis from a degradation. | `query`, `fetch_count` (1–5), `category`, `time_range`, `domain_profile`, `expand`, `language`, `engines`, `site`, `min_score` |
| `fetch_url` | Fetch and extract readable markdown from any public URL. GitHub hosts take the GitHub fast path; YouTube video URLs return the transcript and Reddit thread URLs return post+comments (both opt-in via robots, see below); all others use the fetch cascade (Firecrawl → Crawl4AI → raw HTTP). Trimmed to a token budget (default ~8,000 chars). | `url`, `domain_profile`, `max_tokens`, `target_selector`, `wait_for_selector` |
| `crawl_site` | Crawl an entire site and return a manifest of URL/title/snippet for each page. Tries Firecrawl crawl first, falls back to sitemap parsing, then optional BFS. Full page content is cached in Valkey so follow-up `fetch_url` calls are zero-cost. | `url`, `max_pages` (default: `CRAWL_MAX_PAGES_DEFAULT`), `bfs` (bool, opt-in BFS) |
| `clear_cache` | Purge the search cache, fetch cache, crawl manifest cache, or all. Useful when researching fast-moving topics where cached results may be stale. | `target` (`search`, `fetch`, `crawl`, `all`) |
| `domain_stats` | Read-only view of the [domain capability database](architecture.md#domain-capability-database). With `hostname`: one domain's per-tier success rates and capability flags. Without: an aggregate across all tracked domains (per-tier success, worst failing domains, seen-but-never-fetched count). Returns MCP structured output (`structuredContent`) for programmatic thresholding. | `hostname` (optional) |

## Parameters

**`category`** — `general` (default), `news`, `it`, `science`

**`time_range`** — `day`, `week`, `month`, `year` — limits results by publication date. Omit for all-time results.

**`fetch_count`** — number of top reranked results to fetch full content for (default `1`, max `3` for `search_and_fetch`; default `3`, max `5` for `search_and_summarize`).

**`domain_profile`** — apply a named domain filter profile: `homelab` (surfaces self-hosted/Linux docs) or `dev` (surfaces Stack Overflow, MDN, npm). Omit for default filters.

**`expand`** — when `true`, rewrites the query via Ollama (`OLLAMA_EXPAND_MODEL`) before searching to improve recall. Requires `OLLAMA_URL`. Defaults to the `EXPAND_QUERIES` env var value.

**`language`** — BCP-47 language code (e.g. `en`, `de`) or `all` to restrict to a specific language. Omit to use the SearXNG instance default. Available on `search`, `search_and_fetch`, and `search_and_summarize`.

**`engines`** — comma-separated SearXNG engine names to restrict the search to (e.g. `google,duckduckgo`). Forwarded verbatim; unknown/disabled engines degrade to fewer results rather than erroring. Available on all three search tools.

**`site`** — restrict results to one domain or a list (e.g. `github.com` or `["github.com", "gitlab.com"]`). Applied best-effort as a `site:` query operator — most engines (Google, Bing, DDG, Brave) honor it, some ignore it. Available on all three search tools.

**`max_tokens`** (`fetch_url`) — approximate token budget for returned content (chars ≈ tokens × 4). Omit for the ~2,000-token / 8,000-char default; max 10,000 tokens.

**`target_selector`** (`fetch_url`) — CSS selector to scope extraction to a specific element (e.g. `article`, `main .content`). Honored natively by Firecrawl/Crawl4AI and applied client-side on the raw-HTTP tier; ignored by fast paths and when it matches nothing.

**`wait_for_selector`** (`fetch_url`) — CSS selector to wait for before extracting, for JS-rendered pages. Honored by the rendering tiers (Firecrawl/Crawl4AI); ignored on raw HTTP (no JS).

# GitHub URLs

GitHub URLs are handled natively without Firecrawl. `githubFetch` dispatches on hostname:

- **Repo root** (`github.com/owner/repo`) — fetches the README via the GitHub API
- **File blob** (`github.com/owner/repo/blob/branch/path/to/file`) — rewrites to and fetches raw content from `raw.githubusercontent.com`
- **Raw file** (`raw.githubusercontent.com/...`) — fetched directly as-is
- **API** (`api.github.com/...`) — response decoded (base64 `content` fields) or pretty-printed as JSON

Direct `raw.githubusercontent.com` and `api.github.com` URLs previously matched only `github.com` and fell through to the HTML-scraping tier cascade, which cannot render a raw text file or bare JSON response — they failed 100% of the time. They now take the GitHub fast path.

Unauthenticated requests are rate-limited to 60/hour. Set `GITHUB_TOKEN` to raise this to 5,000/hour.

---

[← Docs index](index.md) · [Architecture](architecture.md)
