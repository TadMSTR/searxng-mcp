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
| `LOG_BLOCKED` | `false` | Log blocked request URLs to stdout |

## How it works

- **Plain HTTP requests**: URL is checked against the loaded filter engine. Blocked URLs
  receive an empty `200` response (not `403`, to avoid triggering retry logic in callers).
  Allowed requests are proxied to the target host.

- **HTTPS CONNECT**: A raw TCP tunnel is established between the client and the target host.
  No content interception. Ad domains accessible only over HTTPS are not blocked.

- **Filter refresh**: Filter lists are downloaded at startup and reloaded every
  `ADBLOCK_REFRESH_HOURS`. The server continues using the previous engine if a refresh
  fails.
