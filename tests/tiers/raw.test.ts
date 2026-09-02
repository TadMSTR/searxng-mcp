import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { ChallengeDetectedError } from "../../src/challenge.js";
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

  it("throws descriptive error on PDF content-type", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "application/pdf" }),
      body: null,
      text: () => Promise.resolve("%PDF-1.4"),
    });
    await expect(rawFetch(URL)).rejects.toThrow(
      "PDF content cannot be extracted by raw fetch",
    );
  });
});

// Cloudflare challenge detection at the tier3 boundary. The 200 case is the
// one that mattered: before this, res.ok was true, Readability extracted
// "Just a moment..." as the article, and the cascade booked a hit.
describe("rawFetch — challenge detection", () => {
  const INTERSTITIAL_200 = `<!DOCTYPE html><html><head>
<title>Just a moment...</title></head><body>
<h1>Verifying you are human. This may take a few seconds.</h1>
<script>window._cf_chl_opt={cvId:'3'};</script>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</body></html>`;

  it("throws ChallengeDetectedError on a 200 interstitial", async () => {
    mockFetch.mockResolvedValueOnce(
      mockHtmlResponse(INTERSTITIAL_200, {
        headers: { "cf-ray": "8f2a1b3c4d5e6f70-LHR", server: "cloudflare" },
      }),
    );
    await expect(rawFetch(URL)).rejects.toBeInstanceOf(ChallengeDetectedError);
  });

  it("throws ChallengeDetectedError on a 503 from a Cloudflare edge", async () => {
    // Ahead of the generic !res.ok throw, so the attempt is recorded as
    // challenge_detected rather than "Raw fetch error: 503".
    mockFetch.mockResolvedValueOnce(
      mockHtmlResponse("", {
        status: 503,
        headers: { "cf-ray": "8f2a1b3c4d5e6f70-LHR" },
      }),
    );
    const err = await rawFetch(URL).catch((e) => e);
    expect(err).toBeInstanceOf(ChallengeDetectedError);
    expect(err.message).not.toContain("Raw fetch error");
  });

  it("still throws the generic error on an honest 403", async () => {
    mockFetch.mockResolvedValueOnce(
      mockHtmlResponse("", { status: 403, headers: { server: "nginx" } }),
    );
    const err = await rawFetch(URL).catch((e) => e);
    expect(err).not.toBeInstanceOf(ChallengeDetectedError);
    expect(err.message).toContain("Raw fetch error: 403");
  });

  it("negative control — a page using 'just a moment' in prose is still a hit", async () => {
    const HONEST = `<html><head><title>Notes on waiting well</title></head><body>
      <article><h1>Notes on waiting well</h1>
      <p>Just a moment ago I was convinced the build was broken, and it was not.</p>
      <p>Give it just a moment and the deploy settles down on its own again.</p>
      </article></body></html>`;
    mockFetch.mockResolvedValueOnce(
      mockHtmlResponse(HONEST, { headers: { server: "cloudflare" } }),
    );
    const result = await rawFetch(URL, 10000);
    expect(result.title).toBe("Notes on waiting well");
    expect(result.text).toContain("Just a moment ago");
  });
});
