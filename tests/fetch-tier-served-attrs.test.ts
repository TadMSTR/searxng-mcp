// fetch.tier_served / fetch.cache_hit on the `fetch` span (4.1.0).
//
// tier_served was on the NATS fetch.completed event only, so a trace could not
// say which tier served a page, and a cache hit (no tier span at all) left no
// marker. Every successful return now sets both attributes and reports them to
// the caller's onServed callback, which tool.fetch_url copies onto its span.
//
// Mock surface copied from fetch-challenge-gate.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const spans = vi.hoisted(() => ({
  attrs: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  WAYBACK_ENABLED: true,
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
  withSpan: (name: string, _attrs: unknown, fn: (s: unknown) => unknown) =>
    fn({
      setAttributes: (a: Record<string, unknown>) => {
        spans.attrs[name] ??= [];
        spans.attrs[name].push(a);
      },
    }),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../src/hister.js", () => ({
  // histerConfigured returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes, histerFetch
  // is called, and it misses. Mocking it false would make the fast path vanish
  // from every test in this file rather than miss in it.
  histerConfigured: vi.fn().mockReturnValue(true),
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  // isLlmsTxtDomain returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes,
  // tryLlmsTxtFetch is called, and it misses. Mocking it false would make the
  // fast path vanish from every test in this file rather than miss in it, which
  // is a quieter kind of green.
  isLlmsTxtDomain: vi.fn().mockReturnValue(true),
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
  isGithubFastPathUrl: () => false,
  rawFetch: vi.fn(),
  solverFetch: vi.fn().mockResolvedValue(null),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { cacheGet } from "../src/cache.js";
import { events } from "../src/events.js";
import { type FetchServed, fetchPage } from "../src/fetch.js";

const URL_ = "https://docs.example.com/page";

beforeEach(() => {
  spans.attrs = {};
  vi.clearAllMocks();
  vi.mocked(cacheGet).mockResolvedValue(null);
  tier1Fetch.mockResolvedValue(null);
  tier2Fetch.mockResolvedValue(null);
  tier3Fetch.mockResolvedValue(null);
});

describe("fetch span: what served the page", () => {
  it("a cache hit is tier_served=cache, cache_hit=true", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify({ title: "C", url: URL_, text: "cached" }),
    );
    const seen: FetchServed[] = [];

    const r = await fetchPage(URL_, 8000, undefined, false, undefined, (s) =>
      seen.push(s),
    );

    expect(r.text).toBe("cached");
    expect(spans.attrs.fetch).toEqual([
      { "fetch.tier_served": "cache", "fetch.cache_hit": true },
    ]);
    expect(seen).toEqual([{ tierServed: "cache", cacheHit: true }]);
    // No tier ran, which is why the marker has to be on the fetch span.
    expect(tier1Fetch).not.toHaveBeenCalled();
  });

  it("a cascade hit names the tier, cache_hit=false, same as the event", async () => {
    tier1Fetch.mockResolvedValue(null);
    tier2Fetch.mockResolvedValue({ title: "T", url: URL_, text: "body" });
    const seen: FetchServed[] = [];

    await fetchPage(URL_, 8000, undefined, false, undefined, (s) =>
      seen.push(s),
    );

    expect(spans.attrs.fetch).toEqual([
      { "fetch.tier_served": "tier2_crawl4ai", "fetch.cache_hit": false },
    ]);
    expect(seen).toEqual([{ tierServed: "tier2_crawl4ai", cacheHit: false }]);
    expect(vi.mocked(events.fetchCompleted).mock.calls[0][0].tier_served).toBe(
      "tier2_crawl4ai",
    );
  });

  it("a failed fetch sets neither attribute and never calls onServed", async () => {
    const onServed = vi.fn();
    await expect(
      fetchPage(URL_, 8000, undefined, false, undefined, onServed),
    ).rejects.toThrow("All fetch tiers failed");
    expect(spans.attrs.fetch).toBeUndefined();
    expect(onServed).not.toHaveBeenCalled();
  });
});
