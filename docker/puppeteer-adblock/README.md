# puppeteer-adblock

Docker image that layers `@ghostery/adblocker-puppeteer` (EasyList + EasyPrivacy)
onto the upstream `trieve/puppeteer-service-ts` image used by Firecrawl, without
forking the upstream source.

## What it does

Firecrawl uses [trieve/puppeteer-service-ts](https://github.com/devflowinc/trieve/tree/main/puppeteer-service-ts)
as its headless Chrome service. That image ships `puppeteer-extra-plugin-adblocker`
with no filter lists configured, which provides no meaningful blocking in practice.

This image adds `@ghostery/adblocker-puppeteer` with EasyList + EasyPrivacy,
loaded at startup via `init-adblock.js`. The result: ads and trackers are blocked
at the network request level inside every page Firecrawl renders, improving
extraction quality for ad-heavy pages.

## How the monkey-patch works

`init-adblock.js` is loaded via `NODE_OPTIONS=--require` before `api.ts` starts.
It patches `Module.prototype.require` to intercept any `require('puppeteer')` or
`require('puppeteer-extra')` call. When detected, it wraps `browser.launch()` so
that every `Browser` returned has its `newPage()` and `createBrowserContext()`
methods patched to call `blocker.enableBlockingInPage(page)` on each new page.

No fork of `api.ts` is needed. The patch composes with `puppeteer-extra` plugins
already installed by the upstream image.

## Known failure modes

| Failure | Effect | Detection |
|---------|--------|-----------|
| Upstream changes its `require('puppeteer')` path | Patch does not apply; pages are unblocked | No `[adblock] wrapping puppeteer-service` log line at startup |
| Filter list fetch fails at startup | Silent continue — pages are unblocked until the next refresh | `[adblock] initial load failed:` log line at startup |
| Node version mismatch | `require` hook may not intercept correctly | Check base image Node version vs the version expected by `@ghostery/adblocker-puppeteer` |
| Base image SHA256 drift | Build may pull a different image than pinned | Rebuild fails or logs an unexpected `puppeteer-service` version |

## Build and use

```bash
# Build from the searxng-mcp repo root
docker build -t puppeteer-adblock ./docker/puppeteer-adblock

# Or via docker compose (rebuilds only if Dockerfile/init-adblock.js changed)
docker compose -f ~/docker/firecrawl-simple/docker-compose.yml \
  up -d --build firecrawl-puppeteer
```

Point Firecrawl's `PLAYWRIGHT_MICROSERVICE_URL` at this container:

```yaml
firecrawl-puppeteer:
  build:
    context: ./docker/puppeteer-adblock
  environment:
    ADBLOCK_FILTERS_URL: "https://easylist.to/easylist/easylist.txt,..."
    ADBLOCK_REFRESH_HOURS: "168"
```

## Verifying adblock is active

Check container logs on startup:

```
[adblock] wrapping puppeteer-service 0.0.6
[adblock] loading filter lists: https://easylist.to/easylist/easylist.txt, ...
[adblock] loaded 2 list(s) in 1234ms
```

The first line confirms the patch applied. If you see `(version unknown)`, the
upstream moved `/app/package.json` — update the path in `init-adblock.js`.

## Updating the base image pin

The Dockerfile pins the base image by SHA256 digest (security check DC-01).
To update the pin to a new tag:

```bash
# Get the current digest for a tag
docker buildx imagetools inspect trieve/puppeteer-service-ts:<tag> \
  --format '{{json .Manifest}}' | jq -r '.digest'

# Or via docker pull + inspect
docker pull trieve/puppeteer-service-ts:<tag>
docker inspect trieve/puppeteer-service-ts:<tag> \
  --format '{{index .RepoDigests 0}}'
```

Update the `FROM` line in `Dockerfile` with the new digest.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADBLOCK_DISABLE` | `false` | Set to `true` to disable adblocking entirely |
| `ADBLOCK_FILTERS_URL` | EasyList + EasyPrivacy | Comma-separated filter list URLs |
| `ADBLOCK_REFRESH_HOURS` | `168` | How often to rebuild filter lists (hours) |
