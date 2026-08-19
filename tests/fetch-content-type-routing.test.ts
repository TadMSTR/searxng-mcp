// Verifies the content-type fast path: a URL serving structured data must be
// routed to tier3 rawFetch and must never reach the browser tiers, while an
// HTML URL — or a host the probe can't read — must run the cascade unchanged.
//
// Modelled on fetch-github-routing.test.ts; the mock surface is the same.

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

// vi.mock factories are hoisted above module-scope consts, so the tier stubs
// have to be created inside vi.hoisted or the factory hits them in the TDZ.
const tiers = vi.hoisted(() => ({
  tier1Fetch: vi.fn(),
  tier2Fetch: vi.fn(),
}));
const { tier1Fetch, tier2Fetch } = tiers;

vi.mock("../src/routing.js", () => ({
  getTiers: vi.fn().mockResolvedValue({
    active: [
      { name: "tier1_firecrawl", slot: "tier1", fetch: tiers.tier1Fetch },
      { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
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

import { probeStructuredContent } from "../src/content-type.js";
import { recordTierAttempt } from "../src/domain-db.js";
import { fetchPage } from "../src/fetch.js";
import { rawFetch } from "../src/tiers/index.js";

const probeMock = vi.mocked(probeStructuredContent);
const rawFetchMock = vi.mocked(rawFetch);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);

beforeEach(() => {
  vi.clearAllMocks();
  probeMock.mockResolvedValue(null);
  tier1Fetch.mockResolvedValue({ title: "t1", url: "u", text: "html body" });
  tier2Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — content-type fast path", () => {
  it("routes a JSON endpoint to tier3 rawFetch and never invokes tier1", async () => {
    // The live failure this replaces: registry.npmjs.org served JSON to
    // Firecrawl, which returned empty markdown and was booked as an
    // `empty_result` tier1 miss.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockResolvedValue({
      title: "https://registry.npmjs.org/express",
      url: "https://registry.npmjs.org/express",
      text: '```json\n{\n  "name": "express"\n}\n```',
    });

    const result = await fetchPage("https://registry.npmjs.org/express");

    expect(rawFetchMock).toHaveBeenCalledOnce();
    expect(tier1Fetch).not.toHaveBeenCalled();
    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(result.text).toContain('"name": "express"');
  });

  it("books the fast path as a tier3 attempt, not tier1", async () => {
    // Accounting matters as much as the routing: this is what stops the
    // domain-db recording JSON hosts as tier1 failures.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockResolvedValue({
      title: "u",
      url: "https://api.osv.dev/v1/vulns/GHSA-x",
      text: "{}",
    });

    await fetchPage("https://api.osv.dev/v1/vulns/GHSA-x");

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      "https://api.osv.dev/v1/vulns/GHSA-x",
      "tier3_rawfetch",
      "hit",
    );
    expect(
      recordTierAttemptMock.mock.calls.some(
        (call) => call[1] === "tier1_firecrawl",
      ),
    ).toBe(false);
  });

  it("runs the normal cascade when the probe finds HTML", async () => {
    probeMock.mockResolvedValue(null);
    await fetchPage("https://example.com/page");
    expect(rawFetchMock).not.toHaveBeenCalled();
    expect(tier1Fetch).toHaveBeenCalledOnce();
  });

  it("falls through to the cascade when the fast path's raw fetch fails", async () => {
    // A probe must not be able to convert a fetchable URL into a hard failure:
    // if rawFetch throws, the browser tiers still get their turn.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockRejectedValue(new Error("connection reset"));

    const result = await fetchPage("https://api.codetabs.com/v1/proxy");

    expect(rawFetchMock).toHaveBeenCalledOnce();
    expect(tier1Fetch).toHaveBeenCalledOnce();
    expect(result.text).toBe("html body"); // tier1's body — the cascade served it
  });

  it("routes every structured kind, not just JSON", async () => {
    for (const kind of ["xml", "yaml", "csv", "text", "toml"] as const) {
      vi.clearAllMocks();
      probeMock.mockResolvedValue(kind);
      rawFetchMock.mockResolvedValue({ title: "u", url: "u", text: "body" });
      await fetchPage(`https://example.com/data.${kind}`);
      expect(
        rawFetchMock,
        `${kind} should take the fast path`,
      ).toHaveBeenCalledOnce();
      expect(tier1Fetch, `${kind} should skip tier1`).not.toHaveBeenCalled();
    }
  });
});
