import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(5),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

const EMPTY_META = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      {
        title: "Result 1",
        url: "https://example.com/1",
        content: "Some content",
        engines: ["google"],
      },
      {
        title: "Result 2",
        url: "https://example.com/2",
        content: "More content",
        engines: ["bing"],
      },
    ],
    meta: {
      answers: [],
      infoboxes: [],
      corrections: [],
      suggestions: [],
    },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_, results) => Promise.resolve(results)),
}));

vi.mock("../src/fetch.js", () => ({
  fetchPage: vi.fn().mockResolvedValue({
    title: "Fetched Page",
    url: "https://example.com/1",
    text: "Page content here",
  }),
}));

vi.mock("../src/ollama.js", () => ({
  summarizePages: vi.fn().mockResolvedValue({ summary: "", citations: [] }),
  formatSummaryResult: vi.fn().mockReturnValue("## Summary\n\ntest"),
}));

vi.mock("../src/events.js", () => ({
  events: {
    searchRequested: vi.fn(),
    searchCompleted: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_name, _attrs, fn) => fn()),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("test-req-id"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { cacheClear, cacheGet, getValkey } from "../src/cache.js";
import type { DomainRecord } from "../src/domain-db.js";
import { fetchPage } from "../src/fetch.js";
import { searxSearch } from "../src/search.js";
import {
  handleClearCache,
  handleDomainStats,
  handleFetchUrl,
  handleSearch,
  handleSearchAndFetch,
  handleSearchAndSummarize,
} from "../src/tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSearch", () => {
  it("calls searxSearch with provided params and returns formatted results", async () => {
    const result = await handleSearch({
      query: "test query",
      num_results: 5,
    });
    expect(searxSearch).toHaveBeenCalledWith(
      "test query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result.content[0].text).toContain("Result 1");
    expect(result.content[0].text).toContain("example.com/1");
  });

  it("passes language param through to searxSearch", async () => {
    await handleSearch({
      query: "test",
      num_results: 3,
      language: "de",
    });
    expect(searxSearch).toHaveBeenCalledWith(
      "test",
      "general",
      3,
      undefined,
      undefined,
      undefined,
      "de",
      undefined,
      undefined,
    );
  });

  it("returns No results found when searxSearch returns empty", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [],
      meta: EMPTY_META,
    });
    const result = await handleSearch({ query: "nothing", num_results: 5 });
    expect(result.content[0].text).toBe("No results found.");
  });

  it("surfaces a direct answer above the results and in structuredContent", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        {
          title: "Result 1",
          url: "https://example.com/1",
          content: "Some content",
          engines: ["google"],
        },
      ],
      meta: {
        answers: [{ answer: "42", url: "https://ref" }],
        infoboxes: [],
        corrections: [],
        suggestions: ["related"],
      },
    });
    const result = await handleSearch({ query: "answer me", num_results: 5 });
    expect(result.content[0].text).toContain("Direct answer");
    expect(result.content[0].text.indexOf("42")).toBeLessThan(
      result.content[0].text.indexOf("Result 1"),
    );
    expect(result.structuredContent?.answers).toEqual([
      { answer: "42", url: "https://ref" },
    ]);
    expect(result.structuredContent?.suggestions).toEqual(["related"]);
  });
});

describe("handleSearchAndFetch", () => {
  it("fetches top result and appends content to search results", async () => {
    const result = await handleSearchAndFetch({
      query: "test",
      fetch_count: 1,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Full content");
    expect(result.content[0].text).toContain("Page content here");
  });

  it("returns No results found when search returns empty", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [],
      meta: EMPTY_META,
    });
    const result = await handleSearchAndFetch({
      query: "nothing",
      fetch_count: 1,
    });
    expect(result.content[0].text).toBe("No results found.");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully with error message", async () => {
    vi.mocked(fetchPage).mockRejectedValueOnce(new Error("Connection refused"));
    const result = await handleSearchAndFetch({
      query: "test",
      fetch_count: 1,
    });
    expect(result.content[0].text).toContain("Could not fetch result 1");
    expect(result.content[0].text).toContain("Connection refused");
  });
});

describe("handleSearchAndSummarize", () => {
  it("falls back to raw fetch output when Ollama unavailable (empty summary)", async () => {
    const result = await handleSearchAndSummarize({
      query: "test",
      fetch_count: 2,
    });
    // summarizePages returns {summary: "", citations: []} — should fall back
    expect(result.content[0].text).toContain("Full content");
  });

  it("returns No results found when search returns empty", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [],
      meta: EMPTY_META,
    });
    const result = await handleSearchAndSummarize({
      query: "nothing",
      fetch_count: 2,
    });
    expect(result.content[0].text).toBe("No results found.");
  });
});

describe("handleFetchUrl", () => {
  it("fetches URL and returns formatted output with title and URL header", async () => {
    const result = await handleFetchUrl({ url: "https://example.com/page" });
    // Default: 8000 chars, no domain profile, preferFit false, no tuning.
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      8000,
      undefined,
      false,
      undefined,
    );
    expect(result.content[0].text).toContain("Title: Fetched Page");
    expect(result.content[0].text).toContain("URL: https://example.com/1");
    expect(result.content[0].text).toContain("Page content here");
  });

  it("converts max_tokens to a char budget (chars ≈ tokens × 4)", async () => {
    await handleFetchUrl({ url: "https://example.com/page", max_tokens: 3000 });
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      12000,
      undefined,
      false,
      undefined,
    );
  });

  it("threads target_selector / wait_for_selector as fetch tuning", async () => {
    await handleFetchUrl({
      url: "https://example.com/page",
      target_selector: "article",
      wait_for_selector: ".loaded",
    });
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      8000,
      undefined,
      false,
      { targetSelector: "article", waitForSelector: ".loaded" },
    );
  });

  it("passes no tuning object when neither selector is provided", async () => {
    await handleFetchUrl({ url: "https://example.com/page", max_tokens: 500 });
    const lastCall = vi.mocked(fetchPage).mock.calls.at(-1);
    expect(lastCall?.[4]).toBeUndefined();
  });

  it("propagates SSRF errors from fetchPage", async () => {
    vi.mocked(fetchPage).mockRejectedValueOnce(
      new Error("Internal/private addresses are not allowed"),
    );
    await expect(
      handleFetchUrl({ url: "http://192.168.1.1/page" }),
    ).rejects.toThrow("Internal/private addresses are not allowed");
  });
});

describe("handleClearCache", () => {
  it("clears both caches when target is all", async () => {
    const result = await handleClearCache({ target: "all" });
    expect(cacheClear).toHaveBeenCalledWith("search:*");
    expect(cacheClear).toHaveBeenCalledWith("fetch:*");
    expect(cacheClear).toHaveBeenCalledWith("crawl:*");
    expect(result.content[0].text).toContain("15 cache entries");
  });

  it("clears only search cache when target is search", async () => {
    await handleClearCache({ target: "search" });
    expect(cacheClear).toHaveBeenCalledWith("search:*");
    expect(cacheClear).not.toHaveBeenCalledWith("fetch:*");
  });

  it("clears only fetch cache when target is fetch", async () => {
    await handleClearCache({ target: "fetch" });
    expect(cacheClear).not.toHaveBeenCalledWith("search:*");
    expect(cacheClear).toHaveBeenCalledWith("fetch:*");
  });

  it("uses singular 'entry' when exactly 1 cleared", async () => {
    vi.mocked(cacheClear).mockResolvedValueOnce(1);
    const result = await handleClearCache({ target: "search" });
    expect(result.content[0].text).toBe("Cleared 1 cache entry.");
  });
});

describe("handleDomainStats", () => {
  const NOW = Date.now();

  function stat(attempts: number, ok: number, fail: number) {
    return { attempts, ok, fail, window_start_ms: NOW };
  }

  function mkRecord(
    domain: string,
    tiers: Partial<DomainRecord["tier_stats_30d"]> = {},
    capabilities: DomainRecord["capabilities"] = {},
  ): DomainRecord {
    return {
      schema_version: 4,
      domain,
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-06-01T00:00:00Z",
      capabilities,
      tier_stats_30d: {
        tier1: stat(0, 0, 0),
        tier2: stat(0, 0, 0),
        tier3: stat(0, 0, 0),
        tier4: stat(0, 0, 0),
        github: stat(0, 0, 0),
        ...tiers,
      },
    };
  }

  it("single mode: returns the record summary and structuredContent when found", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(
        mkRecord(
          "docs.example.com",
          { tier1: stat(10, 9, 1) },
          { seen_in_search: { count: 4, last_seen_at: "x" } },
        ),
      ),
    );
    const result = await handleDomainStats({ hostname: "docs.example.com" });
    expect(result.content[0].text).toContain("tier stats (30d window)");
    expect(result.structuredContent).toMatchObject({
      mode: "single",
      hostname: "docs.example.com",
      found: true,
      aggregate: null,
    });
    expect(result.structuredContent.record?.domain).toBe("docs.example.com");
    expect(result.structuredContent.record?.tiers.tier1.success_rate).toBe(0.9);
    expect(result.structuredContent.record?.capabilities.seen_in_search).toBe(
      4,
    );
  });

  it("single mode: reports found=false with a null record when absent", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(null);
    const result = await handleDomainStats({ hostname: "missing.example.com" });
    expect(result.content[0].text).toContain("No domain-db record");
    expect(result.structuredContent).toMatchObject({
      mode: "single",
      found: false,
      record: null,
      aggregate: null,
    });
  });

  it("aggregate mode: scans the domain-db and returns an aggregate", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        "0",
        ["domain:good.com", "domain:raw.githubusercontent.com"],
      ]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("good.com", { tier1: stat(10, 9, 1) })),
        JSON.stringify(
          mkRecord("raw.githubusercontent.com", { github: stat(28, 0, 28) }),
        ),
      ]);
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan,
      mget,
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    expect(result.content[0].text).toContain("domains tracked: 2");
    expect(result.structuredContent).toMatchObject({
      mode: "aggregate",
      hostname: null,
      found: true,
      record: null,
    });
    expect(result.structuredContent.aggregate?.domains_tracked).toBe(2);
    expect(result.structuredContent.aggregate?.truncated).toBe(false);
    expect(
      result.structuredContent.aggregate?.top_failing.map((f) => f.domain),
    ).toContain("raw.githubusercontent.com");
  });

  it("aggregate mode: found=false when the domain-db is empty", async () => {
    const scan = vi.fn().mockResolvedValueOnce(["0", []]);
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan,
      mget: vi.fn(),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);
    const result = await handleDomainStats({});
    expect(result.structuredContent).toMatchObject({
      mode: "aggregate",
      found: false,
    });
    expect(result.structuredContent.aggregate?.domains_tracked).toBe(0);
  });
});
