import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(5),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue([
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
  ]),
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

import { cacheClear } from "../src/cache.js";
import { fetchPage } from "../src/fetch.js";
import { searxSearch } from "../src/search.js";
import {
  handleClearCache,
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
    );
  });

  it("returns No results found when searxSearch returns empty", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce([]);
    const result = await handleSearch({ query: "nothing", num_results: 5 });
    expect(result.content[0].text).toBe("No results found.");
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
    vi.mocked(searxSearch).mockResolvedValueOnce([]);
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
    vi.mocked(searxSearch).mockResolvedValueOnce([]);
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
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      8000,
      undefined,
    );
    expect(result.content[0].text).toContain("Title: Fetched Page");
    expect(result.content[0].text).toContain("URL: https://example.com/1");
    expect(result.content[0].text).toContain("Page content here");
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
    expect(result.content[0].text).toContain("10 cache entries");
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
