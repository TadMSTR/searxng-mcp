import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { rawFetch } from "../../src/tiers/raw.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

function mockHtmlResponse(
  html: string,
  opts?: { status?: number; headers?: Record<string, string> },
) {
  const status = opts?.status ?? 200;
  const headers = new Headers({
    "Content-Type": "text/html",
    ...opts?.headers,
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers,
    body: null,
    text: () => Promise.resolve(html),
  };
}

const ARTICLE_HTML = `
<html><head><title>Test Article</title></head>
<body>
  <article>
    <h1>Test Article</h1>
    <p>This is the main article content with enough text to pass Readability's scoring threshold.</p>
    <p>More paragraph content here to ensure the article is detected properly by Readability.</p>
  </article>
</body></html>`;

const SIMPLE_HTML = `<html><body><p>simple page</p></body></html>`;

describe("rawFetch", () => {
  it("throws on private/localhost URL (SSRF guard)", async () => {
    await expect(rawFetch("http://localhost/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws on 3xx redirect without echoing Location header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 301,
      statusText: "Moved Permanently",
      headers: new Headers({
        Location: "http://192.168.1.1/internal",
      }),
      body: null,
      text: () => Promise.resolve(""),
    });
    await expect(rawFetch(URL)).rejects.toThrow("Redirect not followed (301)");
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      body: null,
      text: () => Promise.resolve(""),
    });
    await expect(rawFetch(URL)).rejects.toThrow("Raw fetch error: 404");
  });

  it("returns title and text from a simple HTML page", async () => {
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(SIMPLE_HTML));
    const result = await rawFetch(URL);
    expect(result.url).toBe(URL);
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("returns article title when Readability successfully parses content", async () => {
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(ARTICLE_HTML));
    const result = await rawFetch(URL, 10000);
    expect(result.title).toBe("Test Article");
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(ARTICLE_HTML));
    const result = await rawFetch(URL, 10);
    expect(result.text.length).toBeLessThanOrEqual(10);
  });
});
