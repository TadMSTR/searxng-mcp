// How a detected challenge is accounted for, end to end through fetchPage.
//
// The defect this covers: runTier books any non-null result as a hit, so a
// Cloudflare interstitial served with HTTP 200 was Readability-extracted,
// cached for FETCH_CACHE_TTL_SECONDS, and written to domain-db as evidence the
// tier works on that domain — which then feeds tier-skip decisions. A challenge
// must be a miss, carry its own reason, and reach neither the cache nor the ok
// count.
//
// Mock surface modelled on fetch-content-type-routing.test.ts.

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
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
}));
const { tier1Fetch, tier2Fetch, tier3Fetch } = tiers;

vi.mock("../src/routing.js", () => ({
  getTiers: vi.fn().mockResolvedValue({
    active: [
      { name: "tier1_firecrawl", slot: "tier1", fetch: tiers.tier1Fetch },
      { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
      { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
    ],
    skipped: [],
  }),
  TIER_NAME: {},
}));

vi.mock("../src/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn(),
  isGithubUrl: () => false,
  rawFetch: vi.fn(),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { cacheSet } from "../src/cache.js";
import { ChallengeDetectedError } from "../src/challenge.js";
import { recordTierAttempt } from "../src/domain-db.js";
import { events } from "../src/events.js";
import { fetchPage } from "../src/fetch.js";
import { incCounter } from "../src/observability.js";

const cacheSetMock = vi.mocked(cacheSet);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);
const incCounterMock = vi.mocked(incCounter);
const fetchTierMissMock = vi.mocked(events.fetchTierMiss);

const URL = "https://protected.example.com/article";

function challenge() {
  return new ChallengeDetectedError({
    kind: "interstitial_body",
    marker: "title:just-a-moment",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tier1Fetch.mockResolvedValue(null);
  tier2Fetch.mockResolvedValue(null);
  tier3Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — a detected challenge is a miss, not a hit", () => {
  it("records the tier attempt as a miss with reason challenge_detected", async () => {
    tier1Fetch.mockRejectedValue(challenge());

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      URL,
      "tier1_firecrawl",
      "miss",
      "challenge_detected",
    );
  });

  it("does not record the challenged tier as a hit", async () => {
    // The stats-corruption half of the defect: an interstitial booked as a hit
    // is evidence the tier works on this domain, and drives tier-skip routing.
    tier1Fetch.mockRejectedValue(challenge());

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    expect(
      recordTierAttemptMock.mock.calls.some(
        (call) => call[1] === "tier1_firecrawl" && call[2] === "hit",
      ),
    ).toBe(false);
    expect(incCounterMock).not.toHaveBeenCalledWith("fetch", {
      tier: "tier1_firecrawl",
      outcome: "hit",
    });
  });

  it("counts a miss, not an error", async () => {
    // The tier reached the origin and got a well-formed response — it just
    // wasn't content. Booking it as an error would misreport tier health.
    tier1Fetch.mockRejectedValue(challenge());

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    expect(incCounterMock).toHaveBeenCalledWith("fetch", {
      tier: "tier1_firecrawl",
      outcome: "miss",
    });
    expect(incCounterMock).not.toHaveBeenCalledWith("fetch", {
      tier: "tier1_firecrawl",
      outcome: "error",
    });
  });

  it("emits the distinct miss reason, not the generic empty_result", async () => {
    tier1Fetch.mockRejectedValue(challenge());

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    const reasons = fetchTierMissMock.mock.calls
      .filter((call) => call[0].tier === "tier1_firecrawl")
      .map((call) => call[0].reason);
    expect(reasons).toContain("challenge_detected");
    expect(reasons).not.toContain("empty_result");
  });

  it("never writes an interstitial to the fetch cache", async () => {
    // Deployed FETCH_CACHE_TTL_SECONDS is 259200, so a poisoned entry would
    // have persisted three days.
    tier1Fetch.mockRejectedValue(challenge());
    tier2Fetch.mockRejectedValue(challenge());
    tier3Fetch.mockRejectedValue(challenge());

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    expect(cacheSetMock).not.toHaveBeenCalled();
  });

  it("lets a later tier still serve the page after an earlier one is challenged", async () => {
    // A challenge on tier1 must not abort the cascade — it is one tier's miss,
    // not a verdict on the URL.
    tier1Fetch.mockRejectedValue(challenge());
    tier2Fetch.mockResolvedValue({
      title: "Real Article",
      url: URL,
      text: "real body",
    });

    const result = await fetchPage(URL);

    expect(result.title).toBe("Real Article");
    expect(result.text).toBe("real body");
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      URL,
      "tier2_crawl4ai",
      "hit",
    );
    expect(cacheSetMock).toHaveBeenCalledOnce();
  });

  it("leaves a non-challenge tier error recorded as an error", async () => {
    // Narrow change: only ChallengeDetectedError is reclassified.
    tier1Fetch.mockRejectedValue(new Error("connection reset"));

    await expect(fetchPage(URL)).rejects.toThrow("All fetch tiers failed");

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      URL,
      "tier1_firecrawl",
      "error",
      "connection reset",
    );
  });
});
