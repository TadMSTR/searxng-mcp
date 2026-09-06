export { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
export { firecrawlScrape } from "./firecrawl.js";
export { githubFetch, isGithubUrl } from "./github.js";
export { fetchRawHtmlForMetadata, rawFetch } from "./raw.js";
export { buildScopedCookieHeader, solverFetch } from "./solver.js";
export type { Tier } from "./types.js";
export { waybackFetch } from "./wayback.js";

import { assertNoChallengeBody } from "../challenge.js";
import { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
import { firecrawlScrape } from "./firecrawl.js";
import { rawFetch } from "./raw.js";
import type { Tier } from "./types.js";

// Tier 1 and tier 2 reach the origin through an external fetcher, so they hand
// back a rendered document with no origin status or headers — only the body
// rules in detectChallenge can apply. The check sits here at the tier boundary
// rather than inside firecrawlScrape/crawl4aiFetch so one rule covers both
// tiers and raises ChallengeDetectedError by the same path for each. Both
// representations are passed because the markers live in the markup and the
// markdown/text projection strips them.
//
// This used to carry a second reason: that crawl4aiFetch swallowed every throw
// and returned null, so the signal had to be raised outside it. That is no
// longer true. As of vikunja#690 tier 2 throws its backend failures the way
// tier 1 always has, and returns null only for a genuinely empty result.

/** Tier 1 — Firecrawl (Puppeteer-rendered, best quality). */
export const tier1: Tier = {
  name: "tier1_firecrawl",
  slot: "tier1",
  async fetch(url, maxChars, _preferFit, tuning) {
    const r = await firecrawlScrape(url, maxChars, tuning);
    if (!r?.text) return null;
    assertNoChallengeBody(r.html, r.text);
    return r;
  },
};

/** Tier 2 — Crawl4AI (browser automation + Readability post-processing). */
export const tier2: Tier = {
  name: "tier2_crawl4ai",
  slot: "tier2",
  async fetch(url, maxChars, preferFit = false, tuning) {
    const r = await crawl4aiFetch(url, maxChars, preferFit, tuning);
    if (!r) return null;
    assertNoChallengeBody(r.html, r.text);
    return applyTier2Readability(r, url);
  },
};

/** Tier 3 — Raw Node.js fetch + JSDOM Readability. */
export const tier3: Tier = {
  name: "tier3_rawfetch",
  slot: "tier3",
  async fetch(url, maxChars, _preferFit, tuning) {
    return rawFetch(url, maxChars, tuning);
  },
};

/** Canonical ordered tier list. Order determines cascade priority. */
export const ALL_TIERS: readonly Tier[] = [tier1, tier2, tier3];
