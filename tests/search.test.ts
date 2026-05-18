import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategorySchema, TimeRangeSchema } from "../src/types.js";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("cache-key"),
}));

vi.mock("../src/ollama.js", () => ({
  expandQuery: vi.fn().mockResolvedValue(["variant 1", "variant 2"]),
}));

vi.mock("../src/domains.js", () => ({
  applyDomainFilters: vi.fn().mockImplementation((results) => results),
}));

vi.mock("../src/observability.js", () => ({
  withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const makeResult = (url: string) => ({
  title: "Title",
  url,
  content: "content",
  engines: ["google"],
});

function mockSearxResponse(results: object[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ results }),
  };
}

import { cacheGet, cacheSet } from "../src/cache.js";
import { applyDomainFilters } from "../src/domains.js";
import { searxSearch } from "../src/search.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cacheGet).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searxSearch", () => {
  it("fetches from SearXNG on cache miss and caches results", async () => {
    mockFetch.mockResolvedValue(
      mockSearxResponse([
        makeResult("https://a.com"),
        makeResult("https://b.com"),
      ]),
    );
    const results = await searxSearch("query", "general", 2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
  });

  it("returns cached results on cache hit without calling SearXNG", async () => {
    const cached = JSON.stringify([makeResult("https://cached.com")]);
    vi.mocked(cacheGet).mockResolvedValue(cached);
    const results = await searxSearch("query", "general", 5);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://cached.com");
  });

  it("applies domain filters after cache retrieval on cache hit", async () => {
    const cached = JSON.stringify([makeResult("https://cached.com")]);
    vi.mocked(cacheGet).mockResolvedValue(cached);
    await searxSearch("query", "general", 5, undefined, "homelab");
    expect(applyDomainFilters).toHaveBeenCalledWith(
      expect.any(Array),
      "homelab",
    );
  });

  it("passes time_range to SearXNG URL", async () => {
    mockFetch.mockResolvedValue(mockSearxResponse([]));
    await searxSearch("query", "general", 5, "week");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("time_range=week");
  });

  it("passes language param to SearXNG URL when provided", async () => {
    mockFetch.mockResolvedValue(mockSearxResponse([]));
    await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      "de",
    );
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("language=de");
  });

  it("omits language param from SearXNG URL when not provided", async () => {
    mockFetch.mockResolvedValue(mockSearxResponse([]));
    await searxSearch("query", "general", 5);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("language=");
  });

  it("runs expand path: fetches original + variants, deduplicates by URL", async () => {
    mockFetch.mockResolvedValue(
      mockSearxResponse([
        makeResult("https://shared.com"),
        makeResult("https://orig.com"),
      ]),
    );
    const results = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      true,
    );
    // original + 2 variants = 3 calls to fetch; shared.com should appear once
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const urls = results.map((r) => r.url);
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
  });

  it("expand path: variant fetch rejection does not throw", async () => {
    // First call (original) resolves; subsequent calls reject
    mockFetch
      .mockResolvedValueOnce(
        mockSearxResponse([makeResult("https://orig.com")]),
      )
      .mockRejectedValue(new Error("network error"));
    await expect(
      searxSearch("query", "general", 5, undefined, undefined, true),
    ).resolves.toBeDefined();
  });
});

describe("CategorySchema", () => {
  it("accepts valid categories", () => {
    expect(CategorySchema.parse("general")).toBe("general");
    expect(CategorySchema.parse("news")).toBe("news");
    expect(CategorySchema.parse("it")).toBe("it");
    expect(CategorySchema.parse("science")).toBe("science");
  });

  it("defaults to 'general' when undefined", () => {
    expect(CategorySchema.parse(undefined)).toBe("general");
  });

  it("rejects invalid category", () => {
    expect(() => CategorySchema.parse("invalid")).toThrow();
  });
});

describe("TimeRangeSchema", () => {
  it("accepts valid time ranges", () => {
    expect(TimeRangeSchema.parse("day")).toBe("day");
    expect(TimeRangeSchema.parse("week")).toBe("week");
    expect(TimeRangeSchema.parse("month")).toBe("month");
    expect(TimeRangeSchema.parse("year")).toBe("year");
  });

  it("accepts undefined (optional)", () => {
    expect(TimeRangeSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects invalid time range", () => {
    expect(() => TimeRangeSchema.parse("decade")).toThrow();
  });
});
