<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Security

## URL safety (SSRF)

Every outbound fetch to a caller-influenced or discovered URL — the raw-HTTP tier, robots.txt / llms.txt / Wayback / sitemap probes, the BFS crawl link-fetch, and the GitHub fast path — is guarded two ways:

1. **String check** (`assertPublicUrl`) — rejects non-HTTP(S) URLs and private/internal IP *literals*: RFC1918 (`10.x`, `192.168.x`, `172.16–31.x`), loopback (`127.x`, `::1`), link-local / cloud metadata (`169.254.x`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`), IPv4-mapped, and multicast/reserved ranges.
2. **Connect-time DNS validation** — a shared undici dispatcher whose `connect.lookup` validates the *resolved* address (the exact one the socket connects to). This closes the DNS-rebinding / TOCTOU gap where a public hostname resolves to a private address, and it re-runs on **every redirect hop**, so a redirect chain cannot bounce into your internal network.

Firecrawl (tier1) and Crawl4AI (tier2) resolve and fetch the target URL themselves, so the connect-time dispatcher above can't cover them. `fetchPage` and `crawlSite` call `assertResolvedPublic(url)` — a one-time hostname resolution rejecting any private/reserved result — immediately before dispatching to either service, closing the common DNS-rebinding case on that path (narrower TOCTOU window than the connect-time guard, since the service re-resolves).

Configured internal services (Firecrawl, Crawl4AI, SearXNG, Ollama, Reranker) are reached by their own URLs and are intentionally not guarded.

## Redirect protection

The raw-HTTP and GitHub fast-path fetches additionally use `redirect: "manual"` and reject 3xx responses outright (the `Location` header is never echoed back to the caller). Redirect-following probes (robots.txt, llms.txt, sitemap) are covered by the connect-time DNS validation above, which re-checks each hop.

## Transport exposure

stdio has no network surface. The HTTP transport binds `127.0.0.1` by default and is unauthenticated in that configuration; moving it off loopback without setting `SEARXNG_MCP_AUTH_TOKEN` exposes every tool — including arbitrary-URL `fetch_url` and destructive `clear_cache` — to anything that can route to the port. See [HTTP transport authentication](deployment.md#http-transport-authentication).

## Bounded reads

Every response body read from a third party, and the one request body this server reads itself, stops at a byte limit and cancels the rest of the stream rather than buffering the whole thing and checking its size afterwards. A post-hoc size check has already paid the memory cost it is trying to avoid.

| Read | Limit | Notes |
|---|---|---|
| Fetch tiers (raw, Firecrawl, Crawl4AI, solver, Wayback, Reddit, YouTube, GitHub, sitemap/crawl) | `RAW_HTML_MAX_BYTES` (2 MB) | Shared `readBoundedText` helper. |
| `llms-full.txt` probe | `MAX_SIZE_BYTES` (64 MB) | Read one byte past the ceiling so an oversized document is still *detected* as oversized and reported absent, rather than truncated to the limit and served as if complete. |
| HTTP transport request body | `HTTP_MAX_BODY_BYTES` (1 MB) | `initialize` path only; `413` on exceeding. |

The bound is on **bytes retained**, not bytes transferred. Cancellation is not instantaneous — socket buffers and in-flight data mean a peer can still push some way past the cap — so this hard-bounds memory and only reduces transfer (measured roughly 10x against a 40 MB stub).

**One limitation, out of this server's control:** requests carrying an `Mcp-Session-Id` are handled by the MCP SDK's `StreamableHTTPServerTransport.handleRequest()`, which reads its own request body. That read is not bounded by anything here. It is reachable only by a caller that has already authenticated and established a session.

Reads from first-party services configured by the operator — SearXNG and Ollama — are deliberately left unbounded. They are not attacker-influenced, and bounding them would add ceremony without changing a threat.

## Dependency auditing

CI runs `pnpm audit` on every push. The lockfile (`pnpm-lock.yaml`) is committed for reproducible, auditable builds.

## Credential handling

Basic-auth credentials embedded in `SEARXNG_URL` are extracted at startup and sent as an `Authorization` header; the URL used for the request, for cache keys, for log lines, for NATS events and for error messages is always the credential-free origin. This matters more than it looks: Node's `fetch` refuses a URL containing userinfo outright and puts the whole URL — password included — into the resulting `TypeError`'s message, so leaving credentials in the URL would both break every request and leak the password into any sink that forwards an error message.

No credentials are stored or logged by the server. API keys (`FIRECRAWL_API_KEY`, `GITHUB_TOKEN`, `CRAWL4AI_API_TOKEN`) are read from environment variables and used only in outbound requests to their respective services.

## Input validation

Environment variables are validated at startup — `RERANK_RECENCY_WEIGHT` warns on NaN, negative, or >1.0 values. Numeric tool parameters use `z.coerce.number()` with range constraints.

For vulnerability reporting and the supported-versions policy, see [`SECURITY.md`](../SECURITY.md) — deliberately not duplicated here.

---

[← Docs index](index.md)
