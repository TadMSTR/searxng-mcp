import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tier 2 must never send `proxy_config`, and this file is the only place that
 * can prove it — every other crawl4ai test mocks `ADBLOCK_PROXY_URL` to null,
 * so the proxy branch was unreachable from the suite while it was breaking
 * 100% of crawls in production (vikunja#690).
 *
 * The mock therefore sets the variable, which is the deployed configuration.
 */
vi.mock("../../src/config.js", () => ({
  CRAWL4AI_URL: "http://crawl4ai:8000",
  CRAWL4AI_API_TOKEN: undefined,
  ADBLOCK_PROXY_URL: "http://adblock-proxy:8118",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { crawl4aiFetch } from "../../src/tiers/crawl4ai.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

const syncResponse = () =>
  new Response(
    JSON.stringify({
      results: [
        {
          markdown: { raw_markdown: "# Page\n\nSome text" },
          metadata: { title: "Page Title" },
        },
      ],
    }),
    { status: 200 },
  );

describe("crawl4ai request body with ADBLOCK_PROXY_URL set", () => {
  it("does not send proxy_config even when ADBLOCK_PROXY_URL is configured", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.proxy_config).toBeUndefined();
  });

  it("does not send the proxy under any key crawl4ai reads", async () => {
    // 0.9.x rejects both spellings at the trust boundary with HTTP 400, and
    // browser_config is where a future reader would most plausibly re-add it.
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL);

    const raw = mockFetch.mock.calls[0][1].body as string;
    expect(raw).not.toContain("proxy");
    expect(raw).not.toContain("adblock-proxy");
  });

  it("still sends the fields tier 2 depends on", async () => {
    // A body that dropped everything would pass the assertions above.
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL, 8000, false, { targetSelector: "main" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.urls).toEqual([URL]);
    expect(body.crawler_config).toEqual({ css_selector: "main" });
  });
});
