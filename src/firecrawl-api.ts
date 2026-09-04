// The single place a Firecrawl request URL is built.
//
// crawl.ts and tiers/firecrawl.ts each hardcoded their own version prefix and
// drifted apart: the tier on `/v1/scrape`, crawl.ts on `/v2/crawl`. Against the
// deployed v1-only backend the crawl phase 404'd on every call and `crawl_site`
// silently fell through to sitemap parsing, so a wholly dead code path returned
// healthy-looking manifests for the life of the feature (vikunja#644). Both now
// derive their path from here, so the two cannot disagree again.

import {
  FIRECRAWL_API_VERSION,
  FIRECRAWL_URL,
  type FirecrawlApiVersion,
} from "./config.js";

/**
 * Build a versioned Firecrawl endpoint URL. `path` is the part after the
 * version segment — `"scrape"`, `"crawl"`, `` `crawl/${id}` ``, `"map"`.
 */
export function firecrawlEndpoint(
  path: string,
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): string {
  return `${FIRECRAWL_URL}/${version}/${path.replace(/^\/+/, "")}`;
}

/**
 * Whether the configured backend accepts an `actions` array.
 *
 * Only under v1. Upstream self-hosted Firecrawl implements `actions` in
 * Fire-engine alone, which is closed-source and cloud-only — every engine
 * available to a self-host deployment (`fetch`, `playwright`, `pdf`,
 * `document`) reports `actions: false`. Sending one returns HTTP 400
 * `SCRAPE_ACTIONS_NOT_SUPPORTED` and fails the whole request, verified live
 * against firecrawl 2.11.162 on forge. So this is not a graceful-degradation
 * check: sending `actions` under v2 turns every `wait_for_selector` call into a
 * hard tier-1 miss.
 */
export function firecrawlSupportsActions(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): boolean {
  return version === "v1";
}

/**
 * Whether `/map` exists on the configured backend. v2 only — the legacy
 * firecrawl-simple backend has no map endpoint at all, so `crawl_site` must
 * skip straight to its sitemap path rather than probe and 404.
 */
export function firecrawlSupportsMap(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): boolean {
  return version === "v2";
}
