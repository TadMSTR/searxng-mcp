export { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
export { firecrawlScrape } from "./firecrawl.js";
export { githubFetch, isGithubUrl } from "./github.js";
export { fetchRawHtmlForMetadata, rawFetch } from "./raw.js";
export type { Tier } from "./types.js";
export { waybackFetch } from "./wayback.js";

import { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
import { firecrawlScrape } from "./firecrawl.js";
import { rawFetch } from "./raw.js";
import type { Tier } from "./types.js";

/** Tier 1 — Firecrawl (Puppeteer-rendered, best quality). */
export const tier1: Tier = {
  name: "tier1_firecrawl",
  slot: "tier1",
  async fetch(url, maxChars) {
    const r = await firecrawlScrape(url, maxChars);
    return r?.text ? r : null;
  },
};

/** Tier 2 — Crawl4AI (browser automation + Readability post-processing). */
export const tier2: Tier = {
  name: "tier2_crawl4ai",
  slot: "tier2",
  async fetch(url, maxChars, preferFit = false) {
    const r = await crawl4aiFetch(url, maxChars, preferFit);
    return r ? applyTier2Readability(r, url) : null;
  },
};

/** Tier 3 — Raw Node.js fetch + JSDOM Readability. */
export const tier3: Tier = {
  name: "tier3_rawfetch",
  slot: "tier3",
  async fetch(url, maxChars) {
    return rawFetch(url, maxChars);
  },
};

/** Canonical ordered tier list. Order determines cascade priority. */
export const ALL_TIERS: readonly Tier[] = [tier1, tier2, tier3];
