// Lite mode, end to end through the real routing + real tier objects.
//
// The claim under test is negative and cannot be inferred from a green
// cascade: with Firecrawl and Crawl4AI unconfigured, no connection to either
// is *attempted*, and neither tier books an attempt in the domain database.
// A fetch would succeed today either way — slowly, by falling through a failed
// tier 1 — so asserting on the returned content proves nothing about the fix.
//
// Deliberately narrow mock surface: routing.js and tiers/index.js are REAL, so
// the skip decisions and the tier objects under them are the shipped ones.
// Only tiers/raw.js is stubbed, which leaves tier 1's real firecrawlScrape
// wired to the real global fetch — the call this test asserts never happens.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  tierConfigured: vi.fn(),
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
  getOperatorTierSkips: vi.fn(() => []),
}));

vi.mock("../src/domain-db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
  recordPostExtractSample: vi.fn().mockResolvedValue(undefined),
  recordMetadataFetchAttempt: vi.fn().mockResolvedValue(undefined),
  getDomainRecord: vi.fn().mockResolvedValue(null),
  currentWindowStat: (s: unknown) => s,
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

vi.mock("../src/reddit.js", () => ({
  isRedditHost: vi.fn(() => false),
  redditFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/extractors/post-extract.js", () => ({
  postExtract: (r: { baselineTitle: string; baselineText: string }) => ({
    title: r.baselineTitle,
    text: r.baselineText,
    source: "baseline",
    jsonLdPresent: false,
  }),
}));

// Tier 3 only. Tier 1 and tier 2 keep their real implementations so that an
// attempt by either one is observable as a real outbound fetch.
vi.mock("../src/tiers/raw.js", () => ({
  rawFetch: vi.fn().mockResolvedValue({
    title: "Example Domain",
    url: "https://example.com/article",
    text: "served by tier 3",
    html: "<html><body>served by tier 3</body></html>",
  }),
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
}));

import { FIRECRAWL_URL, tierConfigured } from "../src/config.js";
import { recordTierAttempt } from "../src/domain-db.js";
import { fetchPage } from "../src/fetch.js";
import { incCounter } from "../src/observability.js";

const tierConfiguredMock = vi.mocked(tierConfigured);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);
const incCounterMock = vi.mocked(incCounter);

const URL_UNDER_TEST = "https://example.com/article";

/** Every URL global fetch was called with during the case. */
let fetchTargets: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  fetchTargets = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo) => {
    fetchTargets.push(String(input));
    // Anything that gets here in lite mode is the failure the test exists to
    // catch, so fail it the way a dead service would rather than hanging.
    return Promise.reject(new Error("ECONNREFUSED"));
  }) as typeof fetch);
});

describe("lite mode — tier1 and tier2 unconfigured", () => {
  beforeEach(() => {
    tierConfiguredMock.mockReturnValue({
      tier1: false,
      tier2: false,
      tier3: true,
    });
  });

  it("serves content from tier 3", async () => {
    const out = await fetchPage(URL_UNDER_TEST);
    expect(out.text).toContain("served by tier 3");
  });

  it("attempts no connection to Firecrawl", async () => {
    await fetchPage(URL_UNDER_TEST);
    expect(fetchTargets.filter((u) => u.startsWith(FIRECRAWL_URL))).toEqual([]);
  });

  // The stat-pollution fix. A skipped tier is not an attempt, so nothing may
  // reach the domain database on its behalf — those same numbers feed the
  // low_success_rate routing pass and domain_stats.
  it("books no domain-db attempt for either skipped tier", async () => {
    await fetchPage(URL_UNDER_TEST);
    const tiersRecorded = recordTierAttemptMock.mock.calls.map((c) => c[1]);
    expect(tiersRecorded).not.toContain("tier1_firecrawl");
    expect(tiersRecorded).not.toContain("tier2_crawl4ai");
    expect(tiersRecorded).toContain("tier3_rawfetch");
  });

  it("counts both skips with their reason", async () => {
    await fetchPage(URL_UNDER_TEST);
    const skipped = incCounterMock.mock.calls.filter(
      (c) => (c[1] as { outcome?: string })?.outcome === "skipped",
    );
    expect(skipped.map((c) => c[1])).toEqual(
      expect.arrayContaining([
        {
          tier: "tier1_firecrawl",
          outcome: "skipped",
          reason: "not_configured",
        },
        {
          tier: "tier2_crawl4ai",
          outcome: "skipped",
          reason: "not_configured",
        },
      ]),
    );
  });
});

// Negative control. Without this, every assertion above would still pass if
// the cascade never ran at all, or if fetchPage short-circuited before the
// tiers for some unrelated reason.
describe("negative control — tier1 configured", () => {
  beforeEach(() => {
    tierConfiguredMock.mockReturnValue({
      tier1: true,
      tier2: false,
      tier3: true,
    });
  });

  it("does attempt Firecrawl, and books the failed attempt", async () => {
    await fetchPage(URL_UNDER_TEST);
    expect(
      fetchTargets.filter((u) => u.startsWith(FIRECRAWL_URL)).length,
    ).toBeGreaterThan(0);
    expect(recordTierAttemptMock.mock.calls.map((c) => c[1])).toContain(
      "tier1_firecrawl",
    );
  });
});
