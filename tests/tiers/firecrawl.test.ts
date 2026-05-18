import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { firecrawlScrape } from "../../src/tiers/firecrawl.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

function mockSuccess(overrides?: object) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: {
          markdown: "# Title\n\nContent here",
          html: "<h1>Title</h1><p>Content here</p>",
          metadata: {
            title: "Title",
            sourceURL: URL,
          },
          ...overrides,
        },
      }),
  };
}

describe("firecrawlScrape", () => {
  it("returns title, url, text, and html on success", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());
    const result = await firecrawlScrape(URL);
    expect(result.title).toBe("Title");
    expect(result.url).toBe(URL);
    expect(result.text).toContain("Content here");
    expect(result.html).toContain("<h1>");
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());
    const result = await firecrawlScrape(URL, 5);
    expect(result.text.length).toBeLessThanOrEqual(5);
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    await expect(firecrawlScrape(URL)).rejects.toThrow("Firecrawl error: 503");
  });

  it("throws when success is false with error message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ success: false, error: "bot-blocked", data: null }),
    });
    await expect(firecrawlScrape(URL)).rejects.toThrow("bot-blocked");
  });

  it("returns empty text when markdown is empty (not a throw)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockSuccess({ markdown: "", html: "<p>x</p>" }),
    );
    const result = await firecrawlScrape(URL);
    expect(result.text).toBe("");
    expect(result.html).toBe("<p>x</p>");
  });

  it("falls back to url when metadata title is missing", async () => {
    mockFetch.mockResolvedValueOnce(
      mockSuccess({ metadata: { sourceURL: URL } }),
    );
    const result = await firecrawlScrape(URL);
    expect(result.title).toBe(URL);
  });
});
