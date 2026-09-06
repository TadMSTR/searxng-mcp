// Regression guard for vikunja#682: a PDF URL must take the ordinary cascade
// and be served by tier 1.
//
// The bug this replaces was a fast path in fetchPage that matched `.pdf` on the
// pathname and dispatched straight to tier 2, on a comment asserting "Firecrawl
// can't extract PDF text". That was true of trieve/firecrawl v0.0.55 and false
// of the v2 backend, which extracts PDFs natively — verified live 2026-09-05,
// 475,850 characters of markdown from RFC 9110's PDF. Crawl4AI, meanwhile,
// renders the PDF in a browser, finds no text nodes, and fails its own anti-bot
// heuristic, so the fast path routed every PDF to the one tier that could not
// serve it.
//
// These cases prove the *routing*. They cannot prove PDFs work end-to-end — the
// tiers are stubs here. That check is a real fetch_url against a real PDF with
// tier_served asserted, recorded in the build plan's verification section.
//
// Mock surface copied from fetch-content-type-routing.test.ts.

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
  postExtract: vi.fn(
    (_url: string, _html: unknown, base: { text: string }) => ({
      title: "t",
      text: base.text,
      source: "baseline",
      jsonLdPresent: false,
    }),
  ),
}));

const tiers = vi.hoisted(() => ({
  tier1Fetch: vi.fn(),
  tier2Fetch: vi.fn(),
}));

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
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { recordTierAttempt } from "../src/domain-db.js";
import { events } from "../src/events.js";
import { fetchPage } from "../src/fetch.js";

const { tier1Fetch, tier2Fetch } = tiers;
const fetchCompletedMock = vi.mocked(events.fetchCompleted);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);

const PDF_URL = "https://www.rfc-editor.org/rfc/rfc9110.pdf";

beforeEach(() => {
  vi.clearAllMocks();
  tier1Fetch.mockResolvedValue({
    title: "RFC 9110",
    url: PDF_URL,
    text: "HTTP Semantics",
  });
  tier2Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — PDF routing", () => {
  it("serves a .pdf URL from tier1_firecrawl", async () => {
    const result = await fetchPage(PDF_URL);

    expect(tier1Fetch).toHaveBeenCalledOnce();
    expect(result.text).toContain("HTTP Semantics");
    // The assertion that actually pins the bug: tier1 must be the tier of
    // record, not merely a tier that ran. A 200 from the wrong tier is not a
    // pass.
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier1_firecrawl" }),
    );
  });

  it("never dispatches a .pdf URL to tier2 while tier1 can serve it", async () => {
    await fetchPage(PDF_URL);

    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(
      recordTierAttemptMock.mock.calls.some(
        (call) => call[1] === "tier2_crawl4ai",
      ),
    ).toBe(false);
  });

  it("books the attempt against tier1, so domain_stats stops blaming tier2", async () => {
    await fetchPage(PDF_URL);

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "tier1_firecrawl",
      "hit",
    );
  });

  it("falls through to tier2 when tier1 misses, rather than short-circuiting", async () => {
    // The cascade still applies to PDFs — deleting the fast path must not
    // pin them to tier 1 the way it previously pinned them to tier 2.
    tier1Fetch.mockResolvedValue(null);
    tier2Fetch.mockResolvedValue({
      title: "RFC 9110",
      url: PDF_URL,
      text: "from tier two",
    });

    const result = await fetchPage(PDF_URL);

    expect(tier1Fetch).toHaveBeenCalledOnce();
    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(result.text).toContain("from tier two");
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier2_crawl4ai" }),
    );
  });

  it("routes an extensionless PDF the same way — the old fast path could not see these", async () => {
    // The suffix matcher missed every PDF served without a .pdf path, which is
    // why keying on the URL was the wrong predicate even before v2 made the
    // whole fast path obsolete.
    const url = "https://example.com/download?doc=9110";

    await fetchPage(url);

    expect(tier1Fetch).toHaveBeenCalledOnce();
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier1_firecrawl" }),
    );
  });
});
