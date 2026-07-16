import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so CRAWL4AI_URL is set correctly
vi.mock("../../src/config.js", () => ({
  CRAWL4AI_URL: "http://crawl4ai:8000",
  CRAWL4AI_API_TOKEN: undefined,
  ADBLOCK_PROXY_URL: null,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { crawl4aiFetch, pollCrawl4aiTask } from "../../src/tiers/crawl4ai.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

const syncResponse = (text = "# Page Content\n\nSome text") => ({
  ok: true,
  json: () =>
    Promise.resolve({
      results: [
        {
          markdown: { raw_markdown: text },
          metadata: { title: "Page Title" },
          html: "<p>html</p>",
        },
      ],
    }),
});

describe("crawl4aiFetch", () => {
  it("returns result immediately on synchronous response", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    const result = await crawl4aiFetch(URL);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Page Title");
    expect(result?.text).toContain("Some text");
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse("abcdefghij"));
    const result = await crawl4aiFetch(URL, 3);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("abc");
  });

  it("returns null when sync result has empty markdown", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse(""));
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("returns null for invalid task_id format (path traversal guard)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ task_id: "../../etc/passwd" }),
    });
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("returns null when response is not-ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    });
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("omits crawler_config from the request body by default", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toBeUndefined();
  });

  it("maps selectors into crawler_config (css_selector + wait_for)", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL, 8000, false, {
      targetSelector: "main",
      waitForSelector: "#ready",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toEqual({
      css_selector: "main",
      wait_for: "css:#ready",
    });
  });
});

describe("pollCrawl4aiTask", () => {
  it("returns result when status is completed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "completed",
          result: {
            markdown: { raw_markdown: "page content" },
            metadata: { title: "Polled Page" },
            html: null,
          },
        }),
    });

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    // Advance past the initial 2s sleep
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Polled Page");
    expect(result?.text).toBe("page content");
  });

  it("returns null when status is failed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "failed" }),
    });

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
  });

  it("returns null when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    // abort check runs after the 2s sleep, so advance past it
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();
    expect(result).toBeNull();
  });
});
