# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [3.22.0] - 2026-09-03

Cap every read (build `searxng-mcp-bounded-reads-2026-09`, vikunja#638; closes vikunja#423).
Finishes propagating the bounded-read pattern SXNG-23 introduced and only half-applied: every
site that reads a response or request body now stops at a limit instead of buffering the whole
thing and checking its size afterwards.

### Fixed
- **`readBoundedText` had three defects of its own**, fixed before propagating it anywhere.
  Its `!reader` fallback did `(await res.text()).slice(...)` — an unbounded read sitting in the
  fallback path of the fix — and now returns `""`, failing closed. It counted bytes while
  reading and then sliced *characters* off the decoded string, so for any multi-byte body the
  trailing slice could not cut anything the loop had not already bounded; truncation is now
  byte-based end to end. And it hardcoded `RAW_HTML_MAX_BYTES`, so a caller with its own
  ceiling could not express one — there is now an optional limit parameter.
- **Four fetch-side sites buffered whole third-party bodies before capping** and now read
  bounded: the `llms-full.txt` probe (`llms-txt.ts`), the GitHub raw-content and two GitHub API
  reads (`tiers/github.ts`), and the Firecrawl crawl poll (`crawl.ts`).
- **The `llms-full.txt` ceiling was 200 MB**, checked *after* `res.text()` had already
  materialised the body — roughly 400 MB resident at UTF-16. Now 64 MB, checked during the
  read. The read deliberately goes one byte past the ceiling so an oversized document is still
  *detected* as oversized and reported absent; capping at exactly the limit would truncate it
  to the limit, pass the size check, and serve a partial document as if it were complete.
- **The L1 body cache refused the one document it existed for.** `L1_MAX_BYTES` (10 MB) and
  `MAX_SIZE_BYTES` (200 MB) were independently chosen and disagreed, so a document in between
  was accepted, written to Valkey, and then rejected by the in-process cache on every session —
  `docs.anthropic.com/llms-full.txt` is 40.3 MB and hit this every time. Worse, `l1Set` ran its
  eviction loop before discovering the body would not fit, so one oversized document drained
  every other entry to make room that could not exist. The two constants are now tied together,
  and `l1Set` checks whether a body can ever fit before evicting anything.
- **The HTTP transport read request bodies unbounded** (vikunja#423) — a `for await` into
  `Buffer.concat` with no ceiling. Now bails on the chunk that crosses the limit and answers
  `413`. **This is a robustness fix, not an exposure fix.** The ticket reads as an
  unauthenticated DoS and it is not: the bearer gate runs before the body is read, the token is
  set in production, and this path is only reachable before a session exists. What it actually
  closes is a *credentialed* caller — a buggy agent, a runaway retry — being able to OOM a
  container that now serves every agent. The gate ordering is asserted by a test rather than
  left to this paragraph.

### Added
- `HTTP_MAX_BODY_BYTES` (default 1 MB) — maximum request body on the pre-session `initialize`
  path. Named and parsed like `HTTP_MAX_SESSIONS` / `HTTP_SESSION_IDLE_TIMEOUT_MS`.
- README **Bounded reads** section recording every read and its limit, that the bound is on
  bytes *retained* rather than bytes transferred, and the one limitation this repo cannot fix —
  the MCP SDK's own `handleRequest` body read, reachable only post-authentication.

### Changed
- `MAX_SIZE_BYTES` 200 MB → 64 MB. This is a capability boundary, not only a memory one: it
  changes which documents the llms.txt fast path accepts. 64 MB was chosen against the measured
  sizes of all six allowlisted origins rather than the single-digit-MB figure originally
  proposed, which would have dropped `docs.anthropic.com` (40.3 MB) off the fast path entirely.

### Notes
- Reads from first-party SearXNG and Ollama are deliberately left unbounded and documented as
  such — not attacker-influenced, and bounding them would add ceremony without changing a
  threat.
- Tier tests for raw, solver, wayback and GitHub were mocking responses with `body: null`,
  which meant they had been exercising the no-reader fallback rather than the streaming read
  those tiers use in production. Retargeted onto real body streams.

## [3.21.0] - 2026-09-03

Search hardening (build `searxng-mcp-search-hardening-2026-09`, vikunja#144; closes vikunja#637).
Closes the last hard single point of failure, adds a relevance floor, makes the search histogram
interpretable, and fixes the `domain_stats` output-schema contract so it cannot drift again.

### Added
- **Multi-instance SearXNG failover** (vikunja#144). `SEARXNG_URL` now accepts an ordered list of
  interchangeable replicas separated by `,` or `;`. Both separators are taken because the
  comparable server (`ihor-sokoliuk/mcp-searxng`) documents `;`, and accepting only one would
  silently collapse that syntax into a single bogus instance. **A scalar value behaves exactly as
  before** — one request, one host, no health lookup, no added cache traffic, same 10s bound.
  Three properties worth knowing:
  - The timeout budget is **total, not per instance** (`SEARXNG_TOTAL_TIMEOUT_MS`, default 10000,
    with `SEARXNG_ATTEMPT_TIMEOUT_MS` as a per-instance ceiling). Iterating N replicas at 10s each
    would make a total outage take *longer* to report the more replicas you added.
  - Health state lives in the cache rather than in process memory, so one process's discovery of a
    dead instance informs the next call. It deprioritises, never removes: a failed instance goes to
    the back for `SEARXNG_UNHEALTHY_TTL_SECONDS` (default 30), and if every instance is marked down
    the full list is still tried. Fail-soft — a cache outage degrades to "try every instance in
    configured order", never to an error.
  - Failover is **loud**: a `search.failover` NATS event plus a throttled stderr line. A silent
    failover is indistinguishable from a healthy primary, which is how a half-dead deployment goes
    unnoticed for weeks.

  Fan-out is deliberately not implemented — it needs meta reconciliation with no obvious right
  answer (if two instances return different `answers`/`infoboxes`, which wins?), and `searxSearch`
  already merges across expanded query variants.
- **`min_score`** on `search`, `search_and_fetch` and `search_and_summarize`: a relevance floor
  applied after reranking, absent by default. It filters on the **raw cross-encoder
  `relevance_score`**, not on the value used for ordering — that sort key is
  `relevance_score + RERANK_RECENCY_WEIGHT * recencyScore(...)`, which with the default weight of
  0.15 ranges over 0–1.15, so filtering a "minimum relevance" parameter on it would quietly make it
  mean "relevant enough *or* recent enough". Filtering runs before the top-N slice, so the floor
  never costs a result that cleared it.

  Two measured caveats are in the parameter description and the README, because without them the
  knob is misleading. Probed against the local FlashRank service on "how to configure nginx reverse
  proxy": nginx reverse-proxy guide 0.998, Apache `mod_proxy` 0.967, nginx install page 0.0028,
  banana bread recipe 0.0000151. The distribution is strongly bimodal, so anything in roughly
  0.01–0.9 behaves the same and **0.5 is not a midpoint** (use 0.01–0.1); and a high score means
  topically *related*, not correct — an Apache page scored 0.967 on an nginx query. Thresholds are
  model-dependent and not comparable across rerankers. With the reranker unavailable `min_score`
  becomes a no-op with a throttled warning, since returning unfiltered results silently would imply
  a floor that was never applied.
- **A `tool` label on the search histogram and counter.** All three search tools record into one
  `search` histogram that carried only `profile`, and their normal ranges differ by roughly 3x — a
  plain `search` is bounded around ~17.5s while `search_and_summarize` routinely reaches ~50s. The
  observed 7-day maximum of 51.6s was therefore uninterpretable: routine for one tool, alarming for
  another.

### Fixed
- **`domain_stats` was dead on every call** from a solver-enabled deployment (vikunja#637), failing
  with `Additional properties are not allowed ('solver' was unexpected)` since v3.19.0.

  The root cause was not a missing key. The payload is *derived* from `TIER_SLOT_KEYS` in both tool
  modes, while `AllTiersOutputSchema` hand-listed five of the six slots — so the fix is to derive
  the schema from the same constant rather than to add `solver` to the list, which would have
  guaranteed a repeat at the next tier slot. Every slot is now optional: `tier4` requires
  `WAYBACK_ENABLED` and `solver` requires `SOLVER_ENABLED`, so making them required only inverts
  which deployments break — `tier4` already carried this defect latently.

  `DomainRecord["tier_stats_30d"]` is now also derived from `TIER_SLOT_KEYS`. It was a third
  hand-maintained copy of the same closed set, with `newRecord()` as a fourth; as a mapped type the
  compiler rejects any writer that misses a slot.

  735 tests were green while the tool was 100% dead, because the three `domain_stats` assertions use
  `toMatchObject`, which is non-exhaustive. The new test does **not** use `.parse()`, and that is
  the point: server-side the SDK calls zod's `safeParseAsync`, and `z.object()` is *strip*, not
  *strict* — it silently drops an unrecognised key and succeeds. A `.parse()` test would have passed
  on the broken build. What actually rejected the call was the client validating against the
  advertised JSON Schema, so the tests validate real payloads against
  `toJsonSchemaCompat(...)` using the SDK's own converter and validator.
- **Search latency is now recorded on the failure path.** The `catch` previously incremented only
  `errors_total`, so a search that failed after 40s and one that failed instantly were
  indistinguishable — precisely the question this histogram was consulted about during the 300s
  stall. Errors carry `outcome: "error"` rather than being folded in unlabelled, so they do not skew
  the success p99.

  **This does not make the histogram able to see a hang, and does not claim to.** Both the success
  and failure recordings happen after `await fn()` settles, so a call that never returns still
  records nothing at all. Closing that gap needs a watchdog timer independent of the awaited
  promise, which is out of scope here.
- **Four pre-containerization claims in the README**, each checked against the running container:
  `schema_version 5` (it is 6, and the same paragraph already described the 5→6 bump); "runs as
  several concurrent per-agent stdio children" (one shared container since vikunja#149/#321);
  "stderr is the only telemetry sink wired on the deployed PM2 process" (wrong twice — the
  deployment is Docker, and OTel and NATS are both wired); and "clean PM2 restart" (the container
  runs `restart: unless-stopped`). `src/log.ts` carried the same stale claim in its header comment
  and is fixed too.

### Changed
- `SEARXNG_URL` entries that are not valid http(s) URLs are dropped with a warning rather than used
  verbatim. This catches an unset `${SEARXNG_URL}` interpolating to the *literal* placeholder rather
  than to empty. If no entry survives, the default is used and said so loudly — refusing to boot
  would turn one bad env var into a total outage. Repeated entries are de-duplicated so a repeat
  cannot spend the shared timeout budget twice on a host that just failed.
- `ajv` is now an explicit devDependency. It was reachable only as an auto-installed peer of the
  MCP SDK, which is not a dependency the new schema-contract tests should rest on.

### Security

- **Basic-auth credentials in `SEARXNG_URL` are extracted into an `Authorization` header.** Found by
  the security audit of this build. Node's `fetch` refuses a URL containing userinfo *synchronously*,
  before any network I/O, and embeds the whole URL — password included — in the resulting
  `TypeError`'s own message. So a credentialed instance had two problems at once: it could never
  serve a single search, and the password reached every sink that forwards an error message. That
  is the stderr failover line, the `search.failover` NATS event, the generic `error` event (which
  fires on the single-instance path too), the OTel span exported over OTLP, and the error returned
  to the calling agent. Credentials are now lifted out at parse time, so `SEARXNG_URLS` is
  credential-free by construction, and error messages are scrubbed at the generic sinks rather than
  at each call site.

  The test that was supposed to cover this mocked `fetch`'s rejection as a generic `Error`, whose
  message can never contain a URL — it asserted the right property against the wrong failure shape.
  The replacement mocks nothing: real `fetch`, real servers, real refused connections.

### Not included
- **`pageno`** was descoped and is tracked as vikunja#639. Pool-and-slice is the right design, but
  it makes the pool size depend on the requested page, and the cached value records no pool size —
  so a page-1 entry cannot be distinguished from an exhausted one. That is a cache-schema change
  with back-compat implications, not a parameter addition, and it deserves its own audit rather
  than riding along at the tail of this branch. The ticket carries the live measurements taken
  during the assessment (SearXNG returns 32 results on page 1 and 20 thereafter, so the current
  `min(numResults * 3, 20)` cap — not SearXNG's page size — is the binding constraint).

## [3.20.0] - 2026-09-03

Only SearXNG is required, and the code now says so as well as the README (build
`searxng-mcp-lite-mode-2026-09`, vikunja#636). `README.md:160` claimed "SearXNG and Firecrawl are
required" while `README.md:16` correctly said only SearXNG is. The stricter claim was wrong:
`runTier` converts every tier failure into a miss rather than a fatal, and tier 3 is a raw HTTP
fetch plus Readability running wholly in-process. Verified end to end — with Firecrawl, Crawl4AI,
the cache and the reranker all dead, `fetchPage` returns clean extracted content via tier 3.

### Added
- **`FIRECRAWL_ENABLED` and `CRAWL4AI_ENABLED`**, both defaulting to `true` and read as
  `!== "false"`, matching the existing `YOUTUBE_TRANSCRIPT_ENABLED` / `REDDIT_FASTPATH_ENABLED`
  convention. A deployment that sets neither behaves exactly as v3.19.1 did. Deliberately *not*
  derived from whether `FIRECRAWL_URL` was explicitly set: it defaults to `http://localhost:3002`,
  so sniffing the env var would have silently disabled tier 1 for anyone already running Firecrawl
  on the default port — a breaking change dressed as a fix.
- **A startup capability line** naming which of tier1/2/3, cache, reranker, LLM, Kiwix, Hister,
  solver, Wayback, OTel and NATS are configured. It reports configuration, never reachability —
  nothing is probed, so it cannot delay or fail startup. This is the operator's answer to "why is
  quality worse than I expected", which until now had to be guessed at.

### Fixed
- **Tier 1 had no unconfigured guard, unlike tier 2.** `firecrawlScrape` always attempted
  `FIRECRAWL_URL`, so a Firecrawl-less deployment paid a failed connection on every fetch — cheap
  on loopback (ECONNREFUSED), but a routable-but-dead host costs the full 15s
  `AbortSignal.timeout`. With `FIRECRAWL_ENABLED=false` no connection is attempted at all,
  confirmed against a stub listener that counts hits, with the switch left on as the negative
  control.
- **Unconfigured tiers no longer pollute the domain capability database.** Tier 2's null return
  still booked a `miss` through `runTier`, so `tier_stats_30d` accumulated failures meaning "not
  deployed" rather than "tried and failed" — and those same numbers drive `computeTierSkips`
  routing and `domain_stats` output, so the pollution was never cosmetic. Three lite-mode fetches
  measured before and after: **tier1 3 attempts/3 fail and tier2 3 attempts/3 fail, against 0 and 0
  after**, with tier3 3/3 in both. At ten attempts those fabricated failures would have crossed the
  30% threshold and started skipping tiers on the strength of a service that was never installed.

### Changed
- **`not_configured` is a third `SkipReason`** alongside `operator_override` and
  `low_success_rate`, so unconfigured tiers route through the existing skip machinery — the
  `searxng.fetch.tier.skipped` event, the `searxng_fetch_total{outcome=skipped}` counter and the
  routing filter — rather than a parallel gate. That reuse *is* the stat fix: a skipped tier is
  never recorded as an attempt. `not_configured` takes precedence over both other reasons, since
  an override cannot un-skip a tier there is nothing to call.
- **The `skipped` counter is now labelled with `reason`.** Previously
  `searxng_fetch_total{outcome=skipped}` could not distinguish a tier that was never deployed from
  one that is failing. Three values, so cardinality is unaffected, and queries that do not select
  on `reason` aggregate the same total as before.
- **One behaviour change, and it is the point of the build:** with `CRAWL4AI_URL` unset, tier 2
  goes from *attempted, returns null, books a miss* to *skipped, books nothing*. No outbound call
  changes — `crawl4aiFetch` already returned `null` without touching the network — so fetch results
  are identical. What changes is the stats and the log line, which is the defect being fixed.
- **README restructured around a minimal-config path.** Prerequisites is now tiered
  (required / strongly recommended / optional), with each optional service naming the capability it
  unlocks and the variable that turns it on, plus a SearXNG-only Quick Start stating plainly what
  does and does not work in that configuration.

## [3.19.1] - 2026-09-03

Seventeen advisories (9 high) cleared from the production dependency tree, and the CI gate that reported `found 0 vulnerabilities` the entire time they were shipping (build `searxng-mcp-audit-gate-2026-09`, vikunja#633). The versions are the smaller half. The `audit` job ran `npm install --package-lock-only` and audited *that* — which re-resolves every dependency from the semver ranges in `package.json`, answering "what would a fresh install get today" about a tree that ships nowhere. The image is built from `pnpm-lock.yaml`, which pins. So CI read undici 7.29.0 and passed green while the deployed container ran **7.28.0 with four highs**. No `--audit-level` value could have caught that: the threshold picks which findings fail, not which tree is read. Versions drift again in weeks; the gate reading the shipped lockfile is what stops the next drift shipping silently.

### Security
- **All 17 advisories cleared, collapsing to five packages.** Two were lockfile-stale only — `undici` 7.28.0 → **7.29.0** (1 high, 4 moderate: response desynchronization via the retry interceptor, two cross-user cache-directive disclosures, CRLF injection via a blob-like body `type`, cookie attribute injection) and `fast-xml-parser` 5.10.0 → **5.11.1** (1 high). Their caret ranges already admitted the fixed versions, so nothing in the manifest was wrong; `pnpm install` simply will not move a lock entry whose range is already satisfied, and only `pnpm update` does. That distinction is the whole of why these two rotted in place. `pnpm update` also raised the declared floors to `^7.29.0` and `^5.11.1`, so a fresh resolve can no longer land back on the vulnerable version. **Deliberately stayed in undici 7.x** — 8.10.1 is a breaking major outside the declared range, and 7.29.0 clears all five advisories, so 8.x is its own decision with its own testing burden.
- **Three stale override floors raised** — `fast-uri` `>=3.1.2` → `>=4.1.3` (6 high, resolves 4.1.4), `ip-address` `>=10.1.1` → `>=10.3.1` (1 high, 2 moderate, resolves 10.7.0), `qs` `>=6.15.2` → `>=6.16.0` (2 moderate, resolves 6.16.0). All three are transitive under `@modelcontextprotocol/sdk` (`sdk>ajv>fast-uri`, `sdk>express-rate-limit>ip-address`, `sdk>express>qs`), and overriding a transitive past its parent's expected range was the one real risk here; resolution is clean at 329 packages with no conflict. **`fast-uri` is the instructive one:** its floor was written for a 3.x advisory, and the package has since moved into 4.x — where the vulnerable range `[4.0.0, 4.1.3)` lives. An unbounded `>=` floor tracks latest, and latest drifted straight back into a *new* vulnerability. A floor is not protection; the gate is, and the gate was blind. Same mechanism as #207 → #631, and the new floors are unbounded too — they will rot the same way, and only the gate will catch it.
- undici is not a dormant transitive but **live code in the request path** — `ProxyAgent` in `src/tiers/raw.ts`, `Agent` in `src/ssrf-guard.ts`, `Dispatcher` in `src/fetch-utils.ts`, and the v3.19.0 solver replay. Several of the cleared advisories concern cache-directive and cookie handling on exactly that layer. The bump was therefore exercised against a real fetch rather than assumed, with the SSRF guard's rejection of a private target as the negative control.

### Changed
- **The `audit` job reads `pnpm-lock.yaml`** — the `npm install --package-lock-only` + `npm audit` pair is replaced by a single `pnpm audit --prod`. The npm detour existed because npmjs.org returned 410 for the endpoints `pnpm audit` used (SXNG-15 / vikunja#145); **that premise is dead**, so the workaround is deleted rather than worked around. The job needs no install step — audit reads the lockfile directly — and the lockfile is kept honest by the `test` job's existing `pnpm install --frozen-lockfile`.
- **`--audit-level` dropped entirely rather than lowered.** pnpm's default is `low`, so removing the flag is the *strictest* setting, not the absence of one; the fixed tree is clean there. The old relaxation's written rationale named GHSA-frvp-7c67-39w9 (resolved — `@hono/node-server` 2.1.1 shipped in v3.19.0) and pointed at vikunja#218, closed 2026-09-02: a live control whose justification names a fixed CVE and a closed ticket is worse than no comment. If an advisory ever lands with no fix in range, the documented response is a narrow, dated, ticket-referenced `--ignore <CVE>` for that one advisory — not a threshold raise. A gate tuned to pass is the bug being fixed. `--ignore-registry-errors` is deliberately absent for the same reason: a registry outage should be visible, not silently green.
- The gate was verified in **both** directions, since a green run on the fix branch is the same signal the broken gate was already emitting. A throwaway branch pairing the new `ci.yml` with the pre-fix lockfile made the job fail with `17 vulnerabilities found` / exit 1, while its other three jobs stayed green — isolating the failure to the audit job and to the lockfile.

### Removed
- **The committed-looking `package-lock.json`** — six weeks stale, built by nothing, already gitignored and untracked. It made a local `npm audit` report a *third* answer, distinct from either real tree, and cost a wrong "CI is failing" reading during triage of this very ticket.

### Known limitations
- The gate covers the **production** tree only (`--prod`), which is scope parity with the `npm audit --omit=dev` it replaces — so this is not a regression, but devDependency advisories are gated by nothing. `pnpm audit --dev` currently exits 1 with two `vite` advisories (1 high, both Windows-specific, under `vitest`). Tracked as vikunja#634. For the record this release incidentally cleared 4 of the 6 dev-tree advisories that preceded it, via `nanoid` and `postcss`.


## [3.19.0] - 2026-09-02

A challenge-solving fetch tier backed by Byparr, fired **only when a Cloudflare-style challenge is actually detected** (build `searxng-mcp-solver-tier-2026-09`, vikunja#416). The tier is the headline, but the defect found while scoping it is the part that was already costing something: `runTier` books any non-null `TierResult` as a hit, with no content validation beyond truthiness. `rawFetch` throws on `!res.ok`, so a 403/503 challenge was already an error — but an interstitial served with **HTTP 200**, routine for Managed Challenge and Turnstile, passed `res.ok`, was Readability-extracted, booked as a tier success, cached for `FETCH_CACHE_TTL_SECONDS` (**259200 on the deployed container — three days**), and written to domain-db as evidence that the tier works on that domain, which then fed tier-skip decisions. Detection ships first and stands alone; the solver is built on top of it.

### Added
- **Challenge detection (`src/challenge.ts`)** — identifies a challenge from status and headers (403/503 from a Cloudflare edge; status alone is not sufficient, since honest 403s are common) or from interstitial markers in the body. A detected challenge is a **miss** carrying the distinct reason `challenge_detected` rather than the generic `empty_result` — the whole gate depends on that reason being distinguishable. Wired into tier1, tier2 and tier3: the plan named only the raw fetch and the tier2 Readability path, but tier1 runs first and reaches the origin through the same kind of external fetcher, so leaving it out would have left the identical defect live on the most-used path. The check sits at the tier boundary because `crawl4aiFetch` swallows every throw and would have erased the signal. The `Just a moment` marker is scoped to the `<title>` element: as a bare substring it is ordinary English prose, and over-matching — turning honest pages into misses — is a worse failure than the bug being fixed. A negative control asserts exactly that at both the detector and tier layers, and goes red if the marker is ever loosened.
- **Challenge-solving tier (`src/tiers/solver.ts`)** — built against the FlareSolverr `POST /v1` contract, which Byparr implements, so adding FlareSolverr later is configuration rather than code. Byparr is the deployed solver because it ships fortnightly while FlareSolverr's last release is 2026-05-26 and its browser-and-wait approach is documented as failing on Turnstile and Managed Challenge. Inert unless both `SOLVER_ENABLED` and `SOLVER_URL` are set, mirroring `WAYBACK_ENABLED`. Configured by `SOLVER_URL`, `SOLVER_ENABLED`, `SOLVER_MAX_TIMEOUT_MS` (default 60000).
- **Detection-gated dispatch** — the solver runs only when a tier reported `challenge_detected` for the URL *in the current request*, never on an unchallenged one. searxng-mcp already runs two browser-rendering tiers ahead of it, so solving unconditionally would re-render pages that were never challenged at seconds of latency and hundreds of MB each — measured on forge at 523 MiB peak for one solve, 810 MiB for three concurrent. The gate reads a plain local in `fetchPage`, so it is request-scoped by construction, and a test asserts a challenge in one request cannot arm the gate in the next. Dispatched after the tier3 cascade fails and before `tier4_wayback`, following the `tier4_wayback`/`github` precedent of a `TierName` with **no `TierSlot`** — which keeps it out of `computeTierSkips` and the `tier_skip` domain config entirely.

### Security
- **SSRF guard on the solver replay** — the solver fetches on our behalf and reports where it landed, so `solution.url` is a fresh address no guard has seen. It is validated with `assertPublicUrl` + `assertResolvedPublic` before the replay, whether or not the host changed. Solver-returned cookies are scoped to the solved host and never forwarded to another origin, and cookie and User-Agent values carrying control characters or cookie-pair separators are **refused rather than escaped** — the destination header does no escaping of its own. The replay goes through the existing bounded reader rather than returning `solution.response`, which would bypass the size bound, the content-type routing and the extraction path; it therefore re-runs detection, so a "solved" page that is still an interstitial is a miss rather than a cache write.
- **`adblock-proxy` now validates resolved addresses, not hostname strings** (audit finding, MEDIUM, SSRF-10). When `ADBLOCK_PROXY_URL` is set — it is, on the deployed container — `rawFetch` hands undici a `ProxyAgent`, so `safeFetch` never installs `ssrfGuardedDispatcher` and the in-process connect-time DNS check never runs for *any* proxied fetch. The TCP connection is made in the proxy, which regex-matched the literal CONNECT hostname and then called `net.connect(port, host)`, re-resolving with no rebinding protection. Fixed at the delegate rather than by bypassing the proxy for the replay, so it covers every `rawFetch` caller — tier3, wayback and the metadata side-channel — not only the caller this release adds. Reading the file surfaced a second gap: **the plain-HTTP proxy path had no address check at all**, the blocklist having only ever been applied to CONNECT. Both paths now resolve first and connect to the *validated address* rather than re-resolving the name, which removes the rebinding window instead of narrowing it. The old regex list was also weaker than `src/ssrf-guard.ts` — it missed `169.254.0.0/16` (cloud metadata) and `100.64.0.0/10` (CGNAT). **This fix requires the `adblock-proxy` image to be rebuilt; it is inert in a deployment still running the old image.**
- **Dependency floors raised** (vikunja#631) — `hono` to `>=4.12.34` and `@hono/node-server` to `>=2.0.10`, closing five advisories carried by the deployed container. None was reachable: searxng-mcp never imports hono, and every advisory needs a hono construct this server does not instantiate. Raised because five findings resurface in every audit and Renovate pass and cost triage each round. Note these are unbounded `>=` ranges, so they float rather than pin — `>=1.19.13` is how 2.0.8 came to be installed.

### Changed
- **`SCHEMA_VERSION` 5 → 6** for the new `solver` slot in `tier_stats_30d`. Records rebuild fresh rather than migrating, as with every bump before it — a record cannot claim a 30-day window it never measured. The reset is accepted: the v5 window only began 2026-08-19, so little is discarded.
- **The tier-slot roster lives in one place.** `domain-stats.ts` and `domain-snapshot.ts` each kept their own copy of the same closed set, and neither array is exhaustiveness-checked against the union it is typed with — so a slot added to the record but missed in one of them would have been silently dropped from aggregation or silently rejected by the snapshot restore guard. Both now consume `TIER_SLOT_KEYS` from `domain-db.ts`.

### Fixed
- **The release workflow is idempotent** (vikunja#424) — `gh release create` is not, and `create-github-release` had no "does this tag already have a release?" guard. It and `publish-npm` both `needs: build`, so when npm publish failed and the run was re-run with "re-run all jobs", the release job executed a second time and created a duplicate release object; that is how v3.9.0 and v3.12.0 each ended up with an orphaned draft alongside the real release. It now checks for an existing release and uploads the assets with `--clobber` instead, so a re-run converges.

## [3.18.0] - 2026-08-19

Bearer auth on the HTTP transport, and the container image that made it necessary (build `searxng-mcp-containerize-2026-08`, vikunja#321). The transport authenticated nothing, which was survivable only because it binds `127.0.0.1` by default — the launcher comment said as much. Containerising forces a `0.0.0.0` bind so the service resolves by container name, deleting the only control protecting an arbitrary-URL `fetch_url` and a destructive `clear_cache`. So the auth ships in the same release as the Dockerfile, not after it.

### Added
- **Optional bearer auth on the HTTP transport** — `SEARXNG_MCP_AUTH_TOKEN`. When set, every request except `GET /health` must carry `Authorization: Bearer <token>` or receive `401` with `WWW-Authenticate: Bearer`; the response is identical for a missing, malformed and wrong credential, and never echoes what was presented. Tokens are compared as SHA-256 digests, so the check is constant-time and total for any input — a raw `timingSafeEqual` throws on a length mismatch, which would have turned a wrong-length token into a 500. Unset (the default) disables the check entirely, so stdio users and existing loopback-bound deployments are unaffected. The gate sits ahead of session routing, so an unauthenticated caller can neither create a session nor drive one whose ID it has learned. `GET /health` is exempt by design: it is the container healthcheck and returns no secrets.
- **Startup guard for the misconfiguration this exists to prevent** — binding a non-loopback address with no token now logs a loud warning naming the two tools that make it dangerous (`fetch_url` is an arbitrary-URL fetch primitive; `clear_cache` is destructive). A token shorter than 32 characters also warns. This replaces the previous unconditional "no built-in auth" warning on any non-`127.0.0.1` bind, which is no longer true when a token is set.
- **`Dockerfile` + `.dockerignore`** — multi-stage `node:22-alpine` (pinned by index digest), pnpm with `--frozen-lockfile` in both the build and prod-deps stages, runtime as uid 1000 with production dependencies only, and a `HEALTHCHECK` against `/health`. The image defaults to `SEARXNG_MCP_TRANSPORT=http` and `SEARXNG_MCP_HOST=0.0.0.0`, because that is the only configuration in which a container is useful — which is precisely why it warns when no token is set.
- **CI `docker` job** — builds the image and smoke-tests the deployed contract on every PR: `/health` answers without credentials, `/mcp` returns 401 unauthenticated and with a wrong token, 200 with the right one, and the runtime uid is 1000. The compose examples rotted because nothing exercised them; this stops the Dockerfile going the same way.

### Changed
- `AGENTS.md` described `cache.ts` as a "WATCH/MULTI/EXEC atomic update". 3.17.0 replaced that with a Lua compare-and-set — the line was describing the bug that release fixed.

## [3.17.0] - 2026-08-19

Domain-DB write loss + the correctness defects it was masking (build `searxng-mcp-domain-db-writeloss-2026-08`, vikunja#415). Root cause: `cacheAtomicUpdate` implemented optimistic locking with `WATCH`/`MULTI`/`EXEC`, but `getValkey()` returns a module-level singleton connection and `WATCH` is connection-scoped. Concurrent callers interleaved as `WATCH,WATCH,GET,GET,EXEC,EXEC`; both reads saw the same base document and the first `EXEC` cleared the connection's entire watch set, so the second committed unconditionally over stale data. `results !== null` read as a successful commit, so the retry loop never fired and the losing write disappeared with no error. Measured on a real Valkey against the pre-fix code: **50 concurrent writers to one key landed 1 attempt.** In production this left 553 of 572 tracked domains holding only `seen_in_search`, `capabilities.metadata_fetch` populated on **0 of 572** records, and data-driven tier routing — the feature the DB exists to feed — fired exactly once in its lifetime.

### Fixed
- **Domain-DB writes are no longer silently discarded (the core fix)** — `cacheAtomicUpdate` now commits through a Lua compare-and-set: the comparison and the write happen inside one atomic server-side execution, so no amount of connection sharing can produce a stale commit. Paired with an in-process per-key queue, which removes contention between this process's own fire-and-forget writers so the CAS only arbitrates genuinely concurrent (cross-process) writes. The two are complementary — an earlier revision replaced a per-hostname queue *with* `WATCH` on the reasoning that the queue was single-process only; the reasoning was right and the conclusion was wrong. Retry exhaustion is now reachable, so it increments a counter and logs rather than being silently impossible.
- **JSON-LD detection reported false universally** — presence was derived from `postExtract()`'s `source === "json_ld"`, which is only true when JSON-LD supplied the page *body*, additionally requiring a 300+ character `articleBody`. Sites overwhelmingly publish headline and metadata without a body, so `json_ld_article` recorded 0 present across 111 sampled pages while `og:title` — checked directly against the HTML — read 40% on the same sample; `shouldSkipJsonLdPostExtract` then latched those domains off after five samples, making the false negative self-sustaining. `scanJsonLd` now reports presence and extractability as separate facts, and additionally matches Article subtypes (`ScholarlyArticle`, `OpinionNewsArticle`, `LiveBlogPosting`, …) and fully-qualified `https://schema.org/…` `@type` URLs that a bare-name comparison missed.
- **`tier_stats_30d` was not a 30-day window** — the reset fired only on the *next write for that domain*, so a domain fetched once and never revisited kept reporting until the 90-day record TTL (grep.app's `0/10` was 26 days stale and still topping the failing-domains list). `currentWindowStat` applies the cutoff at read time and is shared by `routing.ts` and `domain-stats.ts`, so tier-skip decisions and reporting cannot disagree. `dump-domain` now distinguishes "window expired" from "no data" rather than showing both as the latter.

### Added
- **Content-type fast path** — tier1's 0/27 lifetime record was a routing gap, not a Firecrawl fault: JSON and CDN endpoints (`registry.npmjs.org`, `api.osv.dev`, `cdn.jsdelivr.net`, …) were asked for markdown, returned empty, and were booked as `empty_result`. A fail-open `HEAD` probe now routes `application/json`, `*+json`, XML, YAML, TOML, CSV and `text/plain` straight to tier3. `rawFetch` renders structured bodies as fenced blocks (JSON re-indented) instead of running Readability over them, however tier3 was reached. `application/xhtml+xml` is excluded, and HTML that a server mislabels as `text/plain` is still parsed as markup.
- **Real-Valkey concurrency tests** (`tests/integration/`, gated on `VALKEY_TEST_URL`, skipped when unset) asserting no lost updates at N=50 and that the CAS rejects a stale commit. These exist because the unit-level equivalent could not have caught this: the previous "serializes concurrent writes for the same hostname (no read-modify-write race)" test stubbed `cacheAtomicUpdate` out with a synchronous in-process closure, so it asserted the contract while the implementation was what failed. It has been retitled to what it actually covers.

### Changed
- **`SCHEMA_VERSION` 4 → 5.** Existing tier stats are discarded rather than migrated: they are a biased sample of whichever writer happened to win each race, and they drive tier-skip decisions. Records rebuild fresh on next write, as with the 1→2, 2→3 and 3→4 bumps.
- **Removed `capabilities.llms_txt`**, which had no writer and no reader anywhere in `src/` in any schema version. `llms_full_txt` is the probe that actually runs and feeds `preferred_strategy`.

## [3.16.0] - 2026-07-23

Cache-resilience + observability hardening (build `searxng-cache-resilience-2026-07`, vikunja#143). Root cause: the Valkey cache client had no command timeout and `cacheGet()` is the first `await` in every search, so a CPU-spiked dragonfly made searches hang until the MCP host's 300s idle-abort — with nothing logged. This is now a single long-lived PM2 HTTP process serving all agents, so an unhandled fault or a session leak takes searxng down for everyone silently.

### Fixed
- **Valkey cache client can no longer hang a search (the core fix)** — `getValkey()` now sets `commandTimeout` (2500 ms), `connectTimeout` (3000 ms), and `maxRetriesPerRequest` (2). A stalled/CPU-spiked cache backend now rejects the command instead of hanging forever; the existing fail-soft catches degrade the rejection to a cache miss (serve live), never throwing out of `searxSearch`. Tunable via `CACHE_COMMAND_TIMEOUT_MS` / `CACHE_CONNECT_TIMEOUT_MS` / `CACHE_MAX_RETRIES_PER_REQUEST` (invalid/non-positive values fall back to the defaults rather than becoming a NaN that would disable the timeout).
- **HTTP transport session leak bounded** — sessions were removed only on `transport.onclose`, which an agent killed mid-turn never fires, leaking the transport + its MCP server on the long-lived process. Added an idle-session sweep (`HTTP_SESSION_IDLE_TIMEOUT_MS`, default 10 min) plus an LRU hard-cap backstop (`HTTP_MAX_SESSIONS`, default 256). Sessions with an in-flight request are exempt from both, so a single long-running call (e.g. a large `crawl_site`) is never closed mid-request; the in-flight count is released even on abrupt disconnect, so a genuinely leaked session still becomes evictable. Evictions are logged. (Audit LOW.)

### Added
- **The cache path now logs.** `src/cache.ts` was entirely silent (zero `console.*`; OTel/NATS sinks unset on the running process). Cache connect failures, client errors, unavailable, and per-command errors now emit a throttled `[searxng-mcp]` stderr line (deduped to one per interval per key so a sustained outage leaves a periodic breadcrumb, not a flood). stderr is the only telemetry sink wired on the running PM2 process.
- **Process crash handlers** (`src/index.ts`) — `uncaughtException` logs then exits 1 (clean PM2 restart); `unhandledRejection` logs and continues. Previously a fault anywhere took searxng down for all agents with nothing logged (the 2026-07-16 crash-loop left 10 core dumps and zero log lines).
- **`GET /health` endpoint** — pings Valkey through the new bounded command timeout (so it can never itself hang) and returns `200 {status:"ok",cache:"up"}` or `503 {status:"degraded",cache:"degraded"}`, plus the live session count. Gives sysadmin monitoring a way to detect a degraded cache from the MCP side.
- **NATS username/password auth** (`src/events.ts`) — `initEvents()` now accepts `NATS_USER`/`NATS_PASSWORD` (`opts.user`/`opts.pass`) in addition to the existing `NATS_CREDS` JWT file (creds wins if both set). Forge's `searxng-mcp` NATS user is bcrypt username/password with no `.creds` file, so events could never authenticate before this — the reason NATS telemetry never fired.
- **Graceful-degradation warnings** — the reranker fallback (`src/reranker.ts`) and the ollama/LLM expand + summarize fallbacks (`src/ollama.ts`) now emit one throttled stderr line each when they silently degrade quality, so "why did ranking/summarize get worse" is answerable.

### Changed
- **Version is single-sourced** from `package.json` via the new `src/version.ts` (read at runtime). The `McpServer` version, OTel tracer/meter version, and outbound `USER_AGENT` were independently hardcoded to `3.10.0` / `3.5.0` / `3.7.0` and had drifted from `package.json`; they now all track the real version.
- Removed ~285 MB of orphaned `core.*` crash dumps from the repo root (gitignored, untracked; from the 2026-07-16 crash-loop). The new crash handlers now yield a log line instead of a binary dump if crashes recur.

## [3.15.1] - 2026-07-16

### Security
- **Bounded reads in the Firecrawl/Crawl4AI tiers (SXNG-23)** — `src/tiers/firecrawl.ts` and `src/tiers/crawl4ai.ts` now read responses via `readBoundedText` (2 MB cap) before `JSON.parse` instead of unbounded `res.json()`, matching the tier-3 / robots / llms / sitemap / Reddit fetches. Follow-up to the SXNG-21 audit LOW finding (the Reddit case was fixed in 3.15.0); consistency/defense-in-depth against an unexpectedly large response from those internal services.

## [3.15.0] - 2026-07-16

Feature bundle from a 2026-07-16 competitive review (mcp-searxng, Perplexica, SurfSense, Jina Reader, Tavily/Exa MCP). All additive — no breaking tool-schema changes. Plane: SXNG-21.

### Added
- **`fetch_url` CSS selector controls** — new optional `target_selector` (scope extraction to a matched element) and `wait_for_selector` (wait for a selector before extracting, for JS-rendered pages). Threaded to the tiers that honor them: Firecrawl (`includeTags` + a `wait` action), Crawl4AI (`css_selector` + `wait_for`), and the raw-HTTP tier applies `target_selector` client-side via jsdom before Readability. Selector fields are attached to Firecrawl/Crawl4AI requests only when supplied, so default fetches are byte-identical to before; a selector matching nothing falls back to full-page extraction rather than erroring.
- **`fetch_url` token budget** — new optional `max_tokens` replaces the fixed 8000-char cutoff (chars ≈ tokens × 4). Omitting it preserves the ~2000-token / 8000-char default; larger budgets raise the internal fetch/store size up to a 40000-char ceiling.
- **Native SearXNG answers/infoboxes surfaced** — `search`/`search_and_fetch`/`search_and_summarize` now read the `answers`, `infoboxes`, `corrections`, and `suggestions` fields SearXNG already returns (previously discarded) and render them above the ranked list. The `search` tool also returns them as MCP **structured output** (`structuredContent`) so callers can check for a direct answer without parsing prose. Surfaced alongside full results (no short-circuit) for v1.
- **`engines` and `site` search params** — all three search tools take an optional comma-separated `engines` (forwarded to SearXNG's `engines`) and `site` (single domain or array, applied as a best-effort `site:` query operator). The result cache discriminates on both.
- **YouTube transcript fast path** (`src/youtube.ts`) — for `youtube.com`/`youtu.be` video URLs, pulls captions via the watch page's `captionTracks` → timedtext endpoint and returns the transcript. Kill switch `YOUTUBE_TRANSCRIPT_ENABLED` (default on).
- **Reddit fast path** (`src/reddit.ts`) — for Reddit thread URLs, fetches the public `.json` view and returns the post plus top comments in the standard `{title, url, text}` shape; falls through on 429. Kill switch `REDDIT_FASTPATH_ENABLED` (default on).
- **New env vars:** `YOUTUBE_TRANSCRIPT_ENABLED`, `REDDIT_FASTPATH_ENABLED`, `YOUTUBE_IGNORE_ROBOTS`, `REDDIT_IGNORE_ROBOTS` (all default off for the `*_IGNORE_ROBOTS` pair; see Security).

### Security
- **DNS-rebinding / TOCTOU-safe SSRF guard (SXNG-21)** — the existing `assertPublicUrl` string check blocked private IP *literals* but a public hostname resolving to a private address (DNS rebinding) slipped past it, and pre-resolve-then-fetch has a TOCTOU gap. New `src/ssrf-guard.ts` adds `isPrivateOrReservedAddress` (RFC1918, loopback, link-local/IMDS `169.254`, CGNAT `100.64/10`, IPv6 ULA/link-local, IPv4-mapped, multicast/reserved) and a shared undici dispatcher whose connect-time `lookup` validates the *resolved* address — the exact one the socket connects to, re-checked on every redirect hop. All outbound fetches to caller-influenced or discovered URLs now route through `safeFetch` (string guard + DNS-validating dispatcher): the raw-HTTP tier, robots.txt / llms.txt / Wayback CDX / sitemap probes, the BFS crawl link-fetch (previously unguarded), and the GitHub fast path (protecting `GITHUB_TOKEN` from a poisoned resolution). Configured internal services (Firecrawl, Crawl4AI, SearXNG, Ollama, Reranker) are intentionally not guarded.
- **Fast paths respect robots.txt by default** — the YouTube transcript (under YouTube's robots-disallowed `/api/`) and Reddit (`Disallow: /` for all crawlers) fast paths are gated on the site's robots.txt. Operators can opt into direct fetching on their own instance via `YOUTUBE_IGNORE_ROBOTS` / `REDDIT_IGNORE_ROBOTS` (default off); when off, both fall through to the normal cascade.
- **Pre-resolve guard for tier1/tier2 (audit HIGH)** — Firecrawl (tier1) and Crawl4AI (tier2), the tiers tried *first*, resolve and fetch the target URL themselves, so the connect-time dispatcher can't cover them; only the string-level `assertPublicUrl` ran before handoff, leaving DNS rebinding open on the common path. `fetchPage` and `crawlSite` now `assertResolvedPublic(url)` — resolving the hostname and rejecting any private/reserved result — immediately before the external-fetcher dispatch. Narrower TOCTOU window than the connect-time guard (the service re-resolves), but closes the common stable-rebind case.
- **Reddit `.json` bounded read (audit LOW)** — the Reddit fast path now reads the response via `readBoundedText` (2 MB cap) before `JSON.parse` instead of unbounded `res.json()`. (The pre-existing Firecrawl/Crawl4AI `res.json()` sites are tracked as a follow-up.)
- **IP classifier + validation hardening (audit INFO)** — `isPrivateOrReservedAddress` now also flags RFC 5737 documentation ranges (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`) and the deprecated 6to4 relay (`192.88.99/24`); `target_selector`/`wait_for_selector` are capped at 500 chars; added regression tests asserting alternate IPv4 literal encodings (hex/decimal/octal) are still rejected. `SsrfBlockedError` no longer includes the resolved internal IP in its message (topology non-disclosure).

### Notes
- The YouTube timedtext and Reddit `.json` endpoints are unofficial/undocumented — best-effort, no SLA; both may break on upstream changes (hence the kill switches).
- YouTube/Reddit fast paths record OTel hit/miss counters (`tier: "youtube"|"reddit"`) like the Kiwix/Hister fast paths; they intentionally do **not** add a domain-db `tier_stats_30d` slot (which would force a schema bump), consistent with the sibling fast paths.
- After merge, the per-agent searxng-mcp processes need restarting to pick up the new version — sysadmin step, same as past releases.

## [3.14.1] - 2026-07-16

### Fixed
- **HTTP transport rejected every concurrent client but the first (SXNG-14)** — the process created a single `StreamableHTTPServerTransport` and reused it for every request; only the first client's `initialize` succeeded, every later client got `HTTP 400 "Server already initialized"`. This broke the shared HTTP service (port 8504) for every agent but whichever connected first, blocking the stdio→HTTP cutover across all six agent manifests. New `src/http-transport.ts` routes each request by the `Mcp-Session-Id` header, creating a new transport (and MCP server) per session per the SDK's documented stateful multi-session pattern.

## [3.14.0] - 2026-07-12

### Added
- **`domain_stats` MCP tool** — the domain capability database was previously reachable only via the `dump-domain` CLI (one host at a time). A new read-only `domain_stats` tool exposes it to agents: with `hostname`, one domain's per-tier success rates and capability flags; without, an aggregate across all tracked domains (per-tier success, worst failing domains, seen-but-never-fetched count). Registered via `server.registerTool` with an `outputSchema`, so it returns MCP **structured output** (`structuredContent`) that agents can threshold/compare without parsing prose, alongside the human-readable text block. Read-only, instrumented, and off the fetch/search hot path (bounded, capped, cursor-based `SCAN` with a `truncated` flag).
- **Durable domain-db snapshots + restore** — the domain-db lives only in Valkey under a 90-day TTL and 30-day rolling windows, so a flush or TTL expiry erased capability learning that is expensive to re-acquire. New standalone `domain-db-maintenance` job (`pnpm domain-db-maintenance`) writes a dated JSON snapshot of all `domain:*` records (with count-based retention) and, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, emits domain-db aggregates as OTel gauges (`searxng_domains_tracked`, `searxng_domains_failing`, `searxng_domain_tier_success_ratio{tier}`) — force-flushed before exit so a short-lived run still exports. New `restore-domain-db` CLI (`pnpm restore-domain-db`) re-seeds the domain-db from the newest snapshot after a flush, restoring only missing or strictly-staler keys (compares `last_fetch`, never clobbers a fresher-or-equal live record). Run maintenance on a schedule (cron / PM2 cron-restart) — **not** as an in-process timer, since searxng-mcp runs as several concurrent per-agent stdio children.
- **New env vars:** `DOMAIN_DB_SNAPSHOT_DIR` (default `./domain-db-snapshots`; set to a durable path in deployment) and `DOMAIN_DB_SNAPSHOT_RETENTION` (default `14`).
- **github fast-path domain-db telemetry (SXNG-10)** — GitHub fast-path fetches (`raw.githubusercontent.com` / `api.github.com` / `github.com` README) previously bypassed `runTier()` and recorded no tier stats, so any aggregate under-counted them (this blind spot is what let `raw.githubusercontent.com` sit at 28 attempts / 0 successes invisibly). The dispatch is now routed through `runTier()` with a dedicated `github` slot in `tier_stats_30d`; `dump-domain` prints it alongside tier1-4. Bumps `DomainRecord.schema_version` 3→4 — existing v3 records are treated as stale and rebuilt fresh on next write, same migration approach as the 1→2 and 2→3 bumps.

### Changed
- **Domain-record tier-stats formatter extracted and shared** — the tier-stats rendering used by `dump-domain` now lives in `src/domain-stats.ts` (`formatDomainRecord`) and is reused by the `domain_stats` tool, so the CLI and the tool present identical output. Coverage floor ratcheted to the new measured baseline (lines 74 / statements 72 / functions 74 / branches 65).

### Security
- **Snapshot writes are atomic (FW-01)** — `writeSnapshot` writes to a `.tmp` sibling and renames into place, so a crash mid-write cannot leave a truncated newest snapshot that `loadLatestSnapshot` would reject (breaking restore). Pre-audit baseline fix.
- **Restore-path structural validation (LOW-1)** — `applyRestore` now structurally validates each snapshot record (schema, `domain`, `first_seen`/`last_fetch` strings, a numeric `tier_stats_30d` block for all five slots) before re-seeding it into Valkey. The restore path is the one place external file contents flow back into the live domain-db (where `tier_stats_30d` drives tier-skip routing and `domain_stats` rendering), so a crafted snapshot can no longer inject malformed records that skew routing or crash `domain_stats`. From the security audit; trust-gated (operator-owned snapshot dir) but cheap to close. Snapshot-dir permissions (`0700`) are a deploy-time note for the sysadmin sub-handoff.

### Docs
- **Hister compose documentation (closes SXNG-6)** — `docker-compose.full.yml` gains an optional-service comment block for Hister and `HISTER_URL`/`HISTER_TOKEN` in the MCP-client env block; `docker-compose.example.yml`'s env block gains the same two lines. Hister is a separate deployable (not shipped in the compose), so this documents pointing searxng-mcp at it. README documents the new `domain_stats` tool and a "Domain-db persistence" section.

## [3.13.0] - 2026-07-11

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
- **F-01: cleartext LLM credential warning** — `llmChat()` now emits a one-time `console.error` when `LLM_API_KEY` is set alongside a plain-`http://` `LLM_BASE_URL`, since the bearer token would transmit in cleartext. Not a merge blocker (many `LLM_BASE_URL` deployments are on a trusted internal network) — a deliberate, visible warning rather than a hard failure. From PR #15/#16's security audit (Low, deferred to this follow-up pass).
- **`src/tiers/github.ts` SSRF hardening** — the new `raw.githubusercontent.com`/`api.github.com` fetch paths (added above) now set `redirect: "manual"` and reject 3xx responses without echoing the `Location` header (matches the existing pattern in `src/tiers/raw.ts`; SSRF-02/OE-02 from the shared security-patterns knowledge base). `githubFetch()` also gained a defensive `assertPublicUrl()` call at its top, matching `rawFetch`'s SSRF-08 fix — `fetch.ts` already guards before dispatching here, but `githubFetch` is exported so this protects future direct callers. Caught in this build's own pre-audit self-check before handoff to the security agent.

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

[Unreleased]: https://github.com/TadMSTR/searxng-mcp/compare/v3.18.0...HEAD
[3.18.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.17.0...v3.18.0
[3.17.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.16.0...v3.17.0
[3.16.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.15.1...v3.16.0
[3.15.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.15.0...v3.15.1
[3.15.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.14.1...v3.15.0
[3.14.1]: https://github.com/TadMSTR/searxng-mcp/compare/v3.14.0...v3.14.1
[3.14.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.13.0...v3.14.0
[3.13.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.12.0...v3.13.0
[3.12.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.11.0...v3.12.0
[3.11.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.10.0...v3.11.0
[3.10.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.9.0...v3.10.0
[3.9.0]: https://github.com/TadMSTR/searxng-mcp/compare/v3.8.0...v3.9.0
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
