// vikunja#682 part 4 — when every tier fails, say why, per tier.
//
// The null-collapse this fixes is the structural cause of the whole #682
// investigation. `runTier` reduces every failure to `null`, which is correct for
// the cascade — it just moves on — but the caller then had nothing left to
// explain the outcome with. The old PDF fast path invented a specific cause for
// its null ("PDF extraction requires Crawl4AI (CRAWL4AI_URL not configured)")
// on a deployment where CRAWL4AI_URL was set and crawl4ai was healthy, and that
// message sent an investigator to check configuration that was already correct.
//
// The generic terminal error had the mirror problem: "All fetch tiers failed"
// is equally consistent with nothing being configured, a backend being down,
// and the page genuinely having no content.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  WAYBACK_ENABLED: false,
  YOUTUBE_TRANSCRIPT_ENABLED: false,
  YOUTUBE_IGNORE_ROBOTS: false,
  REDDIT_FASTPATH_ENABLED: false,
  REDDIT_IGNORE_ROBOTS: false,
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  fetchCacheKey: (url: string) => `fetch:${url}`,
}));

vi.mock("../src/domains.js", () => ({
  getBlockList: vi.fn(() => []),
  urlMatchesDomain: vi.fn(() => false),
}));

vi.mock("../src/domain-db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
  recordPostExtractSample: vi.fn().mockResolvedValue(undefined),
  recordMetadataFetchAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  events: {
    fetchRequested: vi.fn(),
    fetchCompleted: vi.fn(),
    fetchTierMiss: vi.fn(),
    fetchTierSkipped: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../src/hister.js", () => ({
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/content-type.js", () => ({
  probeStructuredContent: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/extractors/post-extract.js", () => ({
  postExtract: vi.fn(() => ({
    title: "t",
    text: "x",
    source: "baseline",
    jsonLdPresent: false,
  })),
}));

const tiers = vi.hoisted(() => ({
  tier1Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
  getTiers: vi.fn(),
}));

vi.mock("../src/routing.js", () => ({
  getTiers: tiers.getTiers,
  // The real map. A stubbed-empty TIER_NAME would render every skipped tier as
  // `undefined:` and the assertions below would pass on a blank name.
  TIER_NAME: {
    tier1: "tier1_firecrawl",
    tier2: "tier2_crawl4ai",
    tier3: "tier3_rawfetch",
  },
}));

vi.mock("../src/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn(),
  isGithubUrl: () => false,
  rawFetch: vi.fn(),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { fetchPage } from "../src/fetch.js";

const URL_ = "https://example.com/page";

beforeEach(() => {
  vi.clearAllMocks();
  tiers.getTiers.mockResolvedValue({
    active: [
      { name: "tier1_firecrawl", slot: "tier1", fetch: tiers.tier1Fetch },
      { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
    ],
    skipped: [{ tier: "tier2", reason: "not_configured" }],
  });
  tiers.tier1Fetch.mockResolvedValue(null);
  tiers.tier3Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — terminal failure names every tier", () => {
  it("distinguishes a skipped tier from one that ran and came back empty", async () => {
    // The distinction that matters. An operator reading this needs to know
    // whether to go and configure something or to go and look at a backend.
    await expect(fetchPage(URL_)).rejects.toThrow(
      /tier2_crawl4ai: skipped \(not_configured\)/,
    );
    await expect(fetchPage(URL_)).rejects.toThrow(
      /tier1_firecrawl: attempted, no content/,
    );
  });

  it("surfaces the underlying error from a tier that threw", async () => {
    tiers.tier1Fetch.mockRejectedValue(
      new Error("Firecrawl error: 502 Bad Gateway"),
    );

    await expect(fetchPage(URL_)).rejects.toThrow(
      /tier1_firecrawl: Firecrawl error: 502 Bad Gateway/,
    );
  });

  it("does not report an unconfigured tier as having been attempted", async () => {
    // The precise misreport that started #682: a tier that never ran, blamed
    // for the failure as though it had.
    const err = await fetchPage(URL_).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/tier2_crawl4ai: attempted/);
  });

  it("bounds an unbounded upstream error rather than relaying it whole", async () => {
    // Firecrawl's `data.error` is upstream-controlled text of arbitrary length,
    // and this is the first change that relays a tier's own error to the caller
    // instead of swallowing it. An error message is not a transport for an
    // arbitrary upstream payload.
    tiers.tier1Fetch.mockRejectedValue(new Error("X".repeat(5000)));

    const err = await fetchPage(URL_).catch((e: Error) => e);
    const message = String(err);

    expect(message).toContain("…");
    expect(message.length).toBeLessThan(1000);
    // The other tiers must still be named — truncating one reason must not
    // swallow the rest of the diagnostic.
    expect(message).toContain("tier2_crawl4ai: skipped (not_configured)");
    expect(message).toContain("tier3_rawfetch");
  });

  it("leaves a normal-length reason intact", async () => {
    // Negative control for the cap: without this, a bound that truncated
    // everything would satisfy the test above.
    tiers.tier1Fetch.mockRejectedValue(
      new Error("Firecrawl error: 502 Bad Gateway"),
    );

    const err = await fetchPage(URL_).catch((e: Error) => e);
    expect(String(err)).toContain(
      "tier1_firecrawl: Firecrawl error: 502 Bad Gateway",
    );
    expect(String(err)).not.toContain("…");
  });

  it("still leads with the original message, so existing matchers hold", async () => {
    await expect(fetchPage(URL_)).rejects.toThrow(/^All fetch tiers failed/);
  });

  it("names every tier that took part, none omitted", async () => {
    const err = await fetchPage(URL_).catch((e: Error) => e);
    for (const tier of [
      "tier1_firecrawl",
      "tier2_crawl4ai",
      "tier3_rawfetch",
    ]) {
      expect(String(err)).toContain(tier);
    }
  });

  it("carries the same detail into the error event, not just the throw", async () => {
    // A message that reaches the caller but not the event stream is invisible
    // to anyone debugging from logs after the fact.
    const { events } = await import("../src/events.js");
    await fetchPage(URL_).catch(() => {});
    expect(vi.mocked(events.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        error_type: "all_tiers_failed",
        message: expect.stringContaining("tier2_crawl4ai: skipped"),
      }),
    );
  });
});
