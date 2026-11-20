// Tool-level metrics and span attributes (4.1.0).
//
// searxng_errors_total was incremented in one place, the search wrapper, so a
// failed fetch_url or crawl_site never reached it: SigNoz showed failed
// tool.fetch_url spans and no errors series at all. instrumentTool now counts
// every tool's failure once. The search tools keep their own stage="search"
// count and must not be counted a second time.
//
// The crawl metrics were written to under names nobody created. The tool now
// records the one crawl histogram, labelled with the strategy that answered.

import { beforeEach, describe, expect, it, vi } from "vitest";

const spans = vi.hoisted(() => ({
  attrs: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(0),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      { title: "R1", url: "https://example.com/1", content: "c" },
      { title: "R2", url: "https://example.com/2", content: "c" },
      { title: "R3", url: "https://example.com/3", content: "c" },
    ],
    meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_q, results: unknown[]) =>
      Promise.resolve(results.slice(0, 2)),
    ),
}));

vi.mock("../src/fetch.js", () => ({ fetchPage: vi.fn() }));

vi.mock("../src/ollama.js", () => ({
  summarizePages: vi.fn().mockResolvedValue({ summary: "s", citations: [] }),
  formatSummaryResult: vi.fn().mockReturnValue("## Summary"),
  formatSummaryFallbackNotice: vi.fn().mockReturnValue("notice"),
}));

vi.mock("../src/crawl.js", () => ({
  crawlSite: vi.fn(),
  formatCrawlManifest: vi.fn().mockReturnValue("manifest"),
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn(
    (name: string, _a: unknown, fn: (s: unknown) => unknown): unknown => {
      const span = {
        setAttributes: (a: Record<string, unknown>) => {
          spans.attrs[name] ??= [];
          spans.attrs[name].push(a);
        },
      };
      return fn(span);
    },
  ),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("req"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { crawlSite } from "../src/crawl.js";
import { type FetchServed, fetchPage } from "../src/fetch.js";
import { incCounter, recordHistogram } from "../src/observability.js";
import { searxSearch } from "../src/search.js";
import {
  handleCrawlSite,
  handleFetchUrl,
  handleSearch,
  handleSearchAndFetch,
  handleSearchAndSummarize,
} from "../src/tools.js";

const errorCalls = () =>
  vi
    .mocked(incCounter)
    .mock.calls.filter((c) => c[0] === "errors")
    .map((c) => c[1]);

class SsrfBlockedError extends Error {
  override name = "SsrfBlockedError";
}

const page = { title: "P", url: "https://example.com/1", text: "text" };

beforeEach(() => {
  spans.attrs = {};
  vi.clearAllMocks();
});

describe("searxng_errors_total covers every tool, once", () => {
  it("fetch_url: a throw is counted with the error class, never the message", async () => {
    vi.mocked(fetchPage).mockRejectedValueOnce(
      new SsrfBlockedError("blocked https://secret.example/"),
    );
    await expect(handleFetchUrl({ url: "https://x.example/" })).rejects.toThrow(
      "blocked",
    );
    expect(errorCalls()).toEqual([
      { tool: "fetch_url", stage: "tool", error_type: "SsrfBlockedError" },
    ]);
  });

  it("crawl_site: a throw is counted", async () => {
    vi.mocked(crawlSite).mockRejectedValueOnce(new TypeError("bad"));
    await expect(
      handleCrawlSite({
        url: "https://x.example/",
        max_pages: 2,
        same_domain_only: true,
      }),
    ).rejects.toThrow("bad");
    expect(errorCalls()).toEqual([
      { tool: "crawl_site", stage: "tool", error_type: "TypeError" },
    ]);
  });

  it("search: a failure is counted once, as stage=search", async () => {
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("down"));
    await expect(handleSearch({ query: "q", num_results: 3 })).rejects.toThrow(
      "down",
    );
    expect(errorCalls()).toEqual([
      { tool: "search", stage: "search", error_type: "Error" },
    ]);
  });

  it.each([
    ["search_and_fetch", handleSearchAndFetch],
    ["search_and_summarize", handleSearchAndSummarize],
  ] as const)("%s: each failed page fetch is counted as stage=fetch", async (tool, handler) => {
    vi.mocked(fetchPage)
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new SsrfBlockedError("no"));
    await handler({ query: "q", fetch_count: 2 });
    expect(errorCalls()).toEqual([
      { tool, stage: "fetch", error_type: "SsrfBlockedError" },
    ]);
  });

  it("a successful call counts nothing", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce(page);
    await handleFetchUrl({ url: "https://x.example/" });
    expect(errorCalls()).toEqual([]);
  });
});

describe("crawl_site metrics", () => {
  const args = {
    url: "https://x.example/",
    max_pages: 2,
    same_domain_only: true,
  };

  it("records the crawl histogram with strategy and cached, once", async () => {
    vi.mocked(crawlSite).mockResolvedValueOnce({
      strategy: "sitemap",
      base_url: args.url,
      page_count: 1,
      pages: [],
      cached: true,
    });
    await handleCrawlSite(args);
    const calls = vi.mocked(recordHistogram).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("crawl");
    expect(calls[0][2]).toEqual({ strategy: "sitemap", cached: true });
    // crawl.ts owns searxng_crawl_total (per strategy attempt); the tool must
    // not add a per-call increment under a different label set.
    expect(
      vi.mocked(incCounter).mock.calls.filter((c) => c[0] === "crawl"),
    ).toEqual([]);
    expect(errorCalls()).toEqual([]);
  });

  it("an all-strategies-failed manifest is an error, though nothing threw", async () => {
    vi.mocked(crawlSite).mockResolvedValueOnce({
      strategy: "error",
      base_url: args.url,
      page_count: 0,
      pages: [],
      cached: false,
    });
    await handleCrawlSite(args);
    expect(errorCalls()).toEqual([
      {
        tool: "crawl_site",
        stage: "crawl",
        error_type: "all_strategies_failed",
      },
    ]);
  });
});

describe("span attributes", () => {
  it.each([
    ["search", handleSearch],
    ["search_and_fetch", handleSearchAndFetch],
    ["search_and_summarize", handleSearchAndSummarize],
  ] as const)("tool.%s carries search.result_count after reranking", async (tool, handler) => {
    vi.mocked(fetchPage).mockResolvedValue(page);
    await handler({ query: "q", num_results: 3, fetch_count: 1 });
    // searxSearch returned 3; the reranker mock keeps 2.
    expect(spans.attrs[`tool.${tool}`]).toEqual([{ "search.result_count": 2 }]);
  });

  it.each([
    [{ tierServed: "tier1_firecrawl", cacheHit: false }],
    [{ tierServed: "cache", cacheHit: true }],
  ])("tool.fetch_url copies what served the page: %o", async (served) => {
    vi.mocked(fetchPage).mockImplementationOnce(
      async (_u, _m, _p, _f, _t, onServed?: (s: FetchServed) => void) => {
        onServed?.(served);
        return page;
      },
    );
    await handleFetchUrl({ url: "https://x.example/" });
    expect(spans.attrs["tool.fetch_url"]).toEqual([
      {
        "fetch.tier_served": served.tierServed,
        "fetch.cache_hit": served.cacheHit,
      },
    ]);
  });
});
