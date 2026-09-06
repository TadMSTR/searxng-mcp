# playwright-adblock

EasyList + EasyPrivacy filtering for **Firecrawl v2's renderer**
(`ghcr.io/firecrawl/playwright-service`), layered on without forking it.

This is an **upgrade of existing token adblocking, not a new feature.** Upstream
already filters ads via `AD_SERVING_DOMAINS` — a hardcoded list of 13 substrings
(`doubleclick.net`, `googletagmanager.com`, …). This replaces that with the full
EasyList + EasyPrivacy rule set. Upstream's list still applies underneath, because
this hook defers to it rather than replacing it.

## Why it exists

`docker/puppeteer-adblock/` does the same job for the **v1** renderer
(`trieve/puppeteer-service-ts`). searxng-mcp defaults to
`FIRECRAWL_API_VERSION=v2`, whose renderer is the playwright service — so on
every v2 deployment, tier-1 adblocking was simply absent. See vikunja#696.

## ⚠ Read this before touching the route handler

`init-adblock.js` installs a request interceptor **in front of Firecrawl's
in-browser SSRF guard**. Get it wrong and you delete that guard silently.

Upstream's `api.ts` registers a context route that runs `assertSafeTargetUrl`
before its own ad check, ending in `route.continue()`. In Playwright:

> `route.continue()`: "immediately sends the request to the network; **other
> matching handlers won't be invoked**"
> `route.fallback()`: "ensures other matching handlers are invoked before
> sending the request"
> "Handlers run in reverse order of registration."

A handler registered after upstream's therefore runs **first**, and calling
`continue()` there means `assertSafeTargetUrl` never executes.

**Every path out of this handler ends in `abort()` or `fallback()`. Never
`continue()`.**

This is not a theoretical hazard. `@ghostery/adblocker-playwright`'s own
`enableBlockingInPage()` registers `page.route('**/*')` — page routes take
precedence over context routes — and calls `route.continue()` for every
non-blocked request. That is why this hook does **not** use it, and instead
reuses the library's matching via `fromPlaywrightDetails()` + `match()` while
keeping control of the disposition.

## Verifying it

```bash
./verify-ssrf-guard.sh
```

The assertion that matters is **not** "are ads blocked". The script asserts
that upstream's handler still executes, then builds a deliberately broken
variant (`fallback()` → `continue()`) and asserts the signal **disappears** —
because a test that always passes looks exactly like a test that works.

Measured, and the reason a functional test cannot substitute for this one:

| build | `/scrape` | upstream handler ran? |
|---|---|---|
| shipped (`fallback`) | HTTP 200 | yes |
| regression (`continue`) | HTTP 200 | **no — SSRF guard gone** |

Both return 200. Both render the page. Both block ads.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `ADBLOCK_DISABLE` | unset | `true` no-ops the hook entirely |
| `ADBLOCK_FILTERS_URL` | **unset** | Opt in to fetching lists at runtime, comma-separated |
| `ADBLOCK_REFRESH_HOURS` | `168` | Refresh interval — only applies when fetching |

Filter lists are **baked into the image** at build time and parsed from disk, so
startup needs no network. `ADBLOCK_FILTERS_URL` is deliberately not set as an
image default: doing so would mean the baked lists were never used, with the
opt-in switch defeated by its own default.

Baking is not just an optimisation. Fetching the lists over TLS at startup
crashed the service outright in testing — undici threw
`AssertionError: assert(!this.paused)` from inside its own parser, which is
asynchronous and so cannot be caught by the promise around the fetch. A
published image that renders untrusted pages must not have a startup path that
a third-party CDN hiccup can kill. Same reasoning as vendoring FlashRank's model
into the reranker in v3.25.0.

## Bumping the base image

Pinned by digest (security check DC-01). To bump:

```bash
docker pull ghcr.io/firecrawl/playwright-service:<NEW_TAG>
docker inspect ghcr.io/firecrawl/playwright-service:<NEW_TAG> --format '{{index .RepoDigests 0}}'
```

Then **re-read `api.ts`'s route registration** — the guard this hook chains into
is upstream code and can move — and re-run `./verify-ssrf-guard.sh`.

## Known upstream behaviour

The base image's command is `pnpm start`, which downloads pnpm via corepack on
every boot. The container therefore cannot start without network access even
though the filter lists are baked in. That is upstream's, not this layer's.
