# adblock-proxy

## Intended placement — read before deploying

This is an **open forward proxy with no authentication of any kind.** It makes
outbound requests on behalf of whoever can reach its port. Published on
`0.0.0.0` it is an open relay.

**Put it on a private network or bind it to loopback. Nothing else.** The
supplied `docker-compose.yml` binds `127.0.0.1` and the reference stack keeps it
on an internal network with no host publish.

`ssrf.js` refuses targets that resolve to private or reserved addresses, which
is what stops the proxy being a pivot into whatever network it sits in. It is a
**backstop, not a substitute** for keeping the port private — it constrains
where requests can go, not who may make them.

That control now ships with the artefact rather than living in a comment: the
publish workflow asserts, against the built image, that an internal address is
refused with 403 and that the refusal is logged. The precedent is the reranker's
request cap — a mitigation that exists only in one compose file does not travel
with the image, and this image is published for topologies its author did not
choose (vikunja#697).

### Known limitation

HTTPS is tunnelled via CONNECT without interception, so **filtering applies to
plain-HTTP requests only**. HTTPS ad and tracker domains pass through. For
in-browser filtering that covers HTTPS, see `docker/playwright-adblock/`
(Firecrawl v2) or `docker/puppeteer-adblock/` (v1).


HTTP forward proxy that filters ad and tracker requests using `@ghostery/adblocker`
(EasyList + EasyPrivacy by default). Used by searxng-mcp tiers 2 and 3.

## Architecture: two-sidecar adblocking

searxng-mcp uses two independent adblock mechanisms, one per fetch tier:

| Sidecar | Tier | Mechanism | HTTPS coverage |
|---------|------|-----------|----------------|
| `docker/puppeteer-adblock/` | Tier 1 (Firecrawl/Puppeteer) | CDP-level interception via `@ghostery/adblocker-puppeteer` — hooks into the browser's network stack | Full HTTPS filtering (same process, no MITM needed) |
| `docker/adblock-proxy/` (this service) | Tiers 2+3 (Crawl4AI, raw Node fetch) | HTTP forward proxy — blocks matched plain-HTTP requests; CONNECT tunneled without interception | Plain-HTTP only |

**Why no HTTPS MITM for tiers 2+3:** Full HTTPS filtering would require distributing
a CA certificate to Crawl4AI's Playwright runtime and Node's TLS stack. The primary
benefit of adblocking at tiers 2+3 is reducing outbound tracker/analytics requests
(typically separate domain, often HTTP), not filtering inline ad content. The
complexity-to-benefit ratio doesn't justify it. The tier-1 puppeteer hook already
provides full HTTPS filtering for that tier.

## Usage

```yaml
# examples/compose.full.yml excerpt
services:
  adblock-proxy:
    build:
      context: ./docker/adblock-proxy
    restart: unless-stopped

  searxng-mcp:
    # ... other config ...
    environment:
      ADBLOCK_PROXY_URL: http://adblock-proxy:8118
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8118` | Listen port (Privoxy conventional port) |
| `ADBLOCK_FILTERS_URL` | EasyList + EasyPrivacy | Comma-separated filter list URLs |
| `ADBLOCK_REFRESH_HOURS` | `168` | Filter refresh interval in hours (0 = no refresh) |
| `ADBLOCK_RETRY_MAX_MINUTES` | `30` | Cap on the delay between retries after a failed startup load (see below). A value below 1 or not a number uses the default |
| `LOG_BLOCKED` | `false` | Log blocked request URLs to stdout |

## How it works

- **Plain HTTP requests**: URL is checked against the loaded filter engine. Blocked URLs
  receive an empty `200` response (not `403`, to avoid triggering retry logic in callers).
  Allowed requests are proxied to the target host.

- **HTTPS CONNECT**: A raw TCP tunnel is established between the client and the target host.
  No content interception. Ad domains accessible only over HTTPS are not blocked.

- **Filter refresh**: Filter lists are downloaded at startup and reloaded every
  `ADBLOCK_REFRESH_HOURS`. A load that yields no network filters (every list failed,
  or every list was empty) is treated as failed: at startup the proxy runs with no
  engine and `/health` reports `503`; on a refresh it keeps the previous rule set and
  logs a `WARNING`. The startup log line reports the network and cosmetic filter
  counts and how many lists were fetched.

- **Retry after a failed startup load**: with no engine, the proxy retries the load
  after 1, 2, 4, 8 and 16 minutes, then every `ADBLOCK_RETRY_MAX_MINUTES` (30), until
  one succeeds. Each retry logs one line with its attempt number and the delay to the
  next. Once a load succeeds the retries stop, and the regular
  `ADBLOCK_REFRESH_HOURS` refresh (counted from startup) carries on. A failed
  *scheduled* refresh is not retried early: the previous rule set still filters, and
  `/health` turns `stale` only after two missed intervals.

## Health endpoint

`GET /health` on `PORT` (default `8118`) reports whether a rule set is loaded and
whether it is current:

| Code | `status` | Meaning |
|------|----------|---------|
| `200` | `ok` | A rule set with network filters is loaded from every configured list, and it is newer than two refresh intervals (`2 × ADBLOCK_REFRESH_HOURS`) |
| `200` | `partial` | As `ok`, but some configured lists are missing from the rule set (`lists_fetched < lists_total`). It filters, so the healthcheck passes; watch `status` to alert on it |
| `503` | `stale` | A rule set is loaded and still filters, but it is older than two refresh intervals: refreshes have been failing or refused. Never reported when `ADBLOCK_REFRESH_HOURS` is `0` |
| `503` | `no_filters` | No rule set has loaded. Requests pass through unfiltered |

Every response carries the same fields:

```json
{"status":"ok","network_filters":N,"cosmetic_filters":M,"loaded_at":"<ISO 8601>",
 "lists_fetched":2,"lists_total":2,"last_attempt_at":"<ISO 8601>","last_attempt_ok":true}
```

`loaded_at`, `lists_fetched` and `lists_total` describe the rule set in use.
`last_attempt_at` and `last_attempt_ok` describe the latest load, including a refused
one. A refresh is refused, and the rule set in use kept, when it yields no network
filters or lacks any list that rule set came from (compared by URL, so a refresh
that fetched a different list of the same count is refused too). At startup a partial
set is installed, since it beats none, and `/health` reports `partial` until a refresh
fetches every list.

Only an **origin-form** request for exactly `/health` is answered locally
(`curl http://adblock-proxy:8118/health`). A proxied request for
`http://<host>/health` is an ordinary proxy request and goes through the SSRF guard.
Other origin-form paths return `400`, as before.

The image has a `HEALTHCHECK` that probes this endpoint with Node (the image has no
curl):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "require('http').get({host:'127.0.0.1',port:process.env.PORT||8118,path:'/health',timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('timeout',function(){this.destroy()}).on('error',()=>process.exit(1))"]
```

The start period covers the startup list fetch, which runs before the port opens.
`docker-compose.yml` beside this file repeats the same check as a `healthcheck:`.
