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
 * Everything that differs between the two backends, in one place.
 *
 * These started as independent `firecrawlSupportsX` predicates and reached four
 * entries, at which point answering "what does v1 actually do?" meant grepping
 * four functions and mentally transposing them. The table answers that question
 * directly; the predicates below are thin readers, kept for their call sites and
 * their existing tests.
 *
 * Add a row here rather than a fifth predicate elsewhere.
 */
export interface FirecrawlCapabilities {
  /**
   * Whether the backend accepts an `actions` array.
   *
   * Only under v1. Upstream self-hosted Firecrawl implements `actions` in
   * Fire-engine alone, which is closed-source and cloud-only — every engine
   * available to a self-host deployment (`fetch`, `playwright`, `pdf`,
   * `document`) reports `actions: false`. Sending one returns HTTP 400
   * `SCRAPE_ACTIONS_NOT_SUPPORTED` and fails the whole request, verified live
   * against firecrawl 2.11.162 on forge. So this is not a graceful-degradation
   * check: sending `actions` under v2 turns every `wait_for_selector` call into
   * a hard tier-1 miss.
   */
  actions: boolean;
  /**
   * Whether `/map` exists. v2 only — the legacy firecrawl-simple backend has no
   * map endpoint at all, so `crawl_site` must skip straight to its sitemap path
   * rather than probe and 404.
   */
  map: boolean;
  /**
   * Whether the backend extracts text from PDFs.
   *
   * v2 does, natively, with no `parsers` option needed — verified live
   * 2026-09-05 against firecrawl 2.11.162: `POST /v2/scrape` on RFC 9110's PDF
   * returned 475,850 characters of clean markdown from the same `formats` array
   * an ordinary HTML scrape sends. v1 (trieve/firecrawl 0.0.55) cannot, which is
   * why this is a capability rather than an assumption — see `tiers/raw.ts` for
   * the failure a v1 deployment gets.
   */
  pdf: boolean;
  /**
   * The name of the HTML format in the `formats` array, and of the matching
   * response field.
   *
   * v1's enum is `markdown | rawHtml | screenshot` and it rejects `html` with a
   * 400 that fails the *whole* scrape — so this is not cosmetic. v2 renamed it
   * to `html`. Request and response use the same spelling on both versions, so
   * one value keys both sides.
   */
  htmlFormat: "html" | "rawHtml";
}

const CAPABILITIES: Record<FirecrawlApiVersion, FirecrawlCapabilities> = {
  v1: { actions: true, map: false, pdf: false, htmlFormat: "rawHtml" },
  v2: { actions: false, map: true, pdf: true, htmlFormat: "html" },
};

export function firecrawlCapabilities(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): FirecrawlCapabilities {
  return CAPABILITIES[version];
}

/** See {@link FirecrawlCapabilities.actions}. */
export function firecrawlSupportsActions(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): boolean {
  return firecrawlCapabilities(version).actions;
}

/** See {@link FirecrawlCapabilities.map}. */
export function firecrawlSupportsMap(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): boolean {
  return firecrawlCapabilities(version).map;
}

/** See {@link FirecrawlCapabilities.pdf}. */
export function firecrawlSupportsPdf(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): boolean {
  return firecrawlCapabilities(version).pdf;
}

/** See {@link FirecrawlCapabilities.htmlFormat}. */
export function firecrawlHtmlFormat(
  version: FirecrawlApiVersion = FIRECRAWL_API_VERSION,
): "html" | "rawHtml" {
  return firecrawlCapabilities(version).htmlFormat;
}
