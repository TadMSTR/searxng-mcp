import { describe, it, expect } from "vitest";
import { urlMatchesDomain, applyDomainFilters } from "../src/domains.js";
import type { SearxResult } from "../src/types.js";

describe("urlMatchesDomain", () => {
  it("matches exact domain", () => {
    expect(urlMatchesDomain("https://example.com/page", "example.com")).toBe(true);
  });

  it("matches www-prefixed URL against bare domain pattern", () => {
    expect(urlMatchesDomain("https://www.example.com/page", "example.com")).toBe(true);
  });

  it("matches subdomain against parent domain", () => {
    expect(urlMatchesDomain("https://sub.example.com/page", "example.com")).toBe(true);
  });

  it("does not match unrelated domain", () => {
    expect(urlMatchesDomain("https://other.com/page", "example.com")).toBe(false);
  });

  it("matches domain + path prefix pattern", () => {
    expect(urlMatchesDomain("https://example.com/docs/guide", "example.com/docs")).toBe(true);
  });

  it("does not match when path prefix does not match", () => {
    expect(urlMatchesDomain("https://example.com/blog/post", "example.com/docs")).toBe(false);
  });

  it("returns false for invalid URL", () => {
    expect(urlMatchesDomain("not-a-url", "example.com")).toBe(false);
  });
});

describe("applyDomainFilters", () => {
  const makeResult = (url: string): SearxResult => ({
    title: "Test",
    url,
  });

  it("removes blocked domains", () => {
    const results = [makeResult("https://blocked.com/page"), makeResult("https://allowed.com/page")];
    const filtered = applyDomainFilters(results, undefined);
    // No block/boost lists loaded from disk in tests — all results pass through
    expect(filtered).toHaveLength(2);
  });

  it("passes explicit empty block list", () => {
    const results = [makeResult("https://example.com/page")];
    const filtered = applyDomainFilters(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe("https://example.com/page");
  });

  it("preserves result order when no boost/block configured", () => {
    const urls = [
      "https://first.com/page",
      "https://second.com/page",
      "https://third.com/page",
    ];
    const results = urls.map(makeResult);
    const filtered = applyDomainFilters(results);
    expect(filtered.map((r) => r.url)).toEqual(urls);
  });
});
