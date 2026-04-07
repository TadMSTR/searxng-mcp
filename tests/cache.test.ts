import { describe, it, expect } from "vitest";
import { searchCacheKey, fetchCacheKey } from "../src/cache.js";

describe("searchCacheKey", () => {
  it("produces a consistent key for the same inputs", () => {
    const a = searchCacheKey("hello world", "general", "week");
    const b = searchCacheKey("hello world", "general", "week");
    expect(a).toBe(b);
  });

  it("produces different keys for different queries", () => {
    const a = searchCacheKey("query one", "general");
    const b = searchCacheKey("query two", "general");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different categories", () => {
    const a = searchCacheKey("query", "general");
    const b = searchCacheKey("query", "news");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different time ranges", () => {
    const a = searchCacheKey("query", "general", "day");
    const b = searchCacheKey("query", "general", "week");
    expect(a).not.toBe(b);
  });

  it("key starts with 'search:' prefix", () => {
    const key = searchCacheKey("test", "general");
    expect(key.startsWith("search:")).toBe(true);
  });
});

describe("fetchCacheKey", () => {
  it("produces a consistent key for the same URL", () => {
    const a = fetchCacheKey("https://example.com/page");
    const b = fetchCacheKey("https://example.com/page");
    expect(a).toBe(b);
  });

  it("produces different keys for different URLs", () => {
    const a = fetchCacheKey("https://example.com/page1");
    const b = fetchCacheKey("https://example.com/page2");
    expect(a).not.toBe(b);
  });

  it("key starts with 'fetch:' prefix", () => {
    const key = fetchCacheKey("https://example.com");
    expect(key.startsWith("fetch:")).toBe(true);
  });
});
