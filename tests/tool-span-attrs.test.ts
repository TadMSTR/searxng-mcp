// Parsed argument values on the tool spans.
//
// A boolean argument can arrive as a JSON boolean or as a string ("false"), and
// the 3.31.0 regression was exactly that: the string was read as truthy. The
// tool span is what a deployment check can read afterwards, so it carries the
// value the server PARSED: `crawl.same_domain_only` on tool.crawl_site and
// `search.expand` on the three search tools.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
      {
        title: "R1",
        url: "https://example.com/1",
        content: "c",
        engines: ["g"],
      },
    ],
    meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_q, results) => Promise.resolve(results)),
}));

vi.mock("../src/fetch.js", () => ({
  fetchPage: vi.fn().mockResolvedValue({
    title: "P",
    url: "https://example.com/1",
    text: "text",
  }),
}));

vi.mock("../src/ollama.js", () => ({
  summarizePages: vi.fn().mockResolvedValue({ summary: "s", citations: [] }),
  formatSummaryResult: vi.fn().mockReturnValue("## Summary"),
}));

vi.mock("../src/crawl.js", () => ({
  crawlSite: vi.fn().mockResolvedValue({
    strategy: "sitemap",
    base_url: "https://example.com/",
    page_count: 0,
    pages: [],
    cached: false,
  }),
  formatCrawlManifest: vi.fn().mockReturnValue("manifest"),
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("req"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { crawlSite } from "../src/crawl.js";
import { withSpan } from "../src/observability.js";
import {
  handleCrawlSite,
  handleSearch,
  handleSearchAndFetch,
  handleSearchAndSummarize,
} from "../src/tools.js";

const spanAttrs = (name: string) =>
  vi
    .mocked(withSpan)
    .mock.calls.filter((c) => c[0] === name)
    .map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.mocked(withSpan).mockClear();
  vi.mocked(crawlSite).mockClear();
});

describe("tool.crawl_site", () => {
  it.each([true, false])("carries crawl.same_domain_only=%s", async (v) => {
    await handleCrawlSite({
      url: "https://example.com/",
      max_pages: 5,
      same_domain_only: v,
    });
    expect(spanAttrs("tool.crawl_site")).toEqual([
      { "mcp.tool": "crawl_site", "crawl.same_domain_only": v },
    ]);
    // The span carries the value crawlSite was actually given.
    expect(vi.mocked(crawlSite).mock.calls[0][2]).toBe(v);
  });
});

describe("search tools", () => {
  const base = { query: "q", num_results: 3, fetch_count: 1 };

  it.each([
    ["search", handleSearch],
    ["search_and_fetch", handleSearchAndFetch],
    ["search_and_summarize", handleSearchAndSummarize],
  ] as const)("tool.%s carries search.expand", async (name, handler) => {
    // biome-ignore lint/suspicious/noExplicitAny: the three handlers take different argument shapes; base satisfies each.
    const h = handler as (a: any) => Promise<unknown>;
    await h({ ...base, expand: true });
    await h({ ...base, expand: false });
    await h({ ...base });
    expect(spanAttrs(`tool.${name}`).map((a) => a["search.expand"])).toEqual([
      true,
      false,
      false,
    ]);
  });
});
