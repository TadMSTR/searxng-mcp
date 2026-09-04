// Tier 1 against a v2 backend.
//
// The load-bearing assertion here is the absence of `actions`. Upstream
// self-hosted Firecrawl implements actions in Fire-engine alone, which is
// closed-source and cloud-only; every engine a self-host deployment can reach
// reports `actions: false`. Verified live against firecrawl 2.11.162 on forge:
// a scrape carrying an actions array returns HTTP 400
// SCRAPE_ACTIONS_NOT_SUPPORTED and the whole request fails, so re-introducing
// it would turn every wait_for_selector call into a hard tier-1 miss rather
// than a degraded one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENV = ["FIRECRAWL_API_VERSION", "FIRECRAWL_URL", "FIRECRAWL_WAIT_FOR_MS"];

function clearEnv() {
  for (const k of ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  clearEnv();
});

afterEach(clearEnv);

const URL_ = "https://example.com/page";

function scrapeResponse(metadata: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        markdown: "# Title\n\nContent here",
        html: "<h1>Title</h1>",
        metadata: { title: "Title", sourceURL: URL_, ...metadata },
      },
    }),
    { status: 200 },
  );
}

async function loadTier(version: "v1" | "v2") {
  process.env.FIRECRAWL_API_VERSION = version;
  process.env.FIRECRAWL_URL = "http://fc:3002";
  return (await import("../../src/tiers/firecrawl.js")).firecrawlScrape;
}

/** The request body of the single fetch the tier issued. */
function sentBody(): Record<string, unknown> {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [, init] = mockFetch.mock.calls[0];
  return JSON.parse(init.body as string);
}

function sentUrl(): string {
  return mockFetch.mock.calls[0][0] as string;
}

describe("firecrawlScrape under v2", () => {
  it("posts to /v2/scrape", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_);
    expect(sentUrl()).toBe("http://fc:3002/v2/scrape");
  });

  it("never sends an actions array when wait_for_selector is requested", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_, 8000, { waitForSelector: "#main" });
    const body = sentBody();
    expect(body).not.toHaveProperty("actions");
    expect(JSON.stringify(body)).not.toContain("actions");
  });

  it("downgrades wait_for_selector to a waitFor delay", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_, 8000, { waitForSelector: "#main" });
    expect(sentBody().waitFor).toBe(2000);
  });

  it("honours FIRECRAWL_WAIT_FOR_MS for the downgrade", async () => {
    process.env.FIRECRAWL_WAIT_FOR_MS = "500";
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_, 8000, { waitForSelector: "#main" });
    expect(sentBody().waitFor).toBe(500);
  });

  it("sends neither actions nor waitFor on a default scrape", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_);
    const body = sentBody();
    expect(body).not.toHaveProperty("actions");
    expect(body).not.toHaveProperty("waitFor");
  });

  it("keeps target_selector on includeTags, which v2 supports unchanged", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await firecrawlScrape(URL_, 8000, { targetSelector: "article" });
    expect(sentBody().includeTags).toEqual(["article"]);
  });

  it("misses with a typed reason when the page itself 404s inside a 200 envelope", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse({ statusCode: 404 }));
    const firecrawlScrape = await loadTier("v2");
    await expect(firecrawlScrape(URL_)).rejects.toThrow(
      "Firecrawl page status: 404",
    );
  });

  it("accepts a 2xx page status", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse({ statusCode: 200 }));
    const firecrawlScrape = await loadTier("v2");
    await expect(firecrawlScrape(URL_)).resolves.toMatchObject({
      title: "Title",
    });
  });

  it("accepts 304, which a conditional request can serve a body with", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse({ statusCode: 304 }));
    const firecrawlScrape = await loadTier("v2");
    await expect(firecrawlScrape(URL_)).resolves.toMatchObject({
      title: "Title",
    });
  });

  it("treats an absent page status as unknown, not as a failure", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v2");
    await expect(firecrawlScrape(URL_)).resolves.toMatchObject({
      title: "Title",
    });
  });
});

describe("firecrawlScrape under v1 is unchanged", () => {
  it("posts to /v1/scrape", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v1");
    await firecrawlScrape(URL_);
    expect(sentUrl()).toBe("http://fc:3002/v1/scrape");
  });

  it("still sends a selector wait action, which the v1 backend supports", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse());
    const firecrawlScrape = await loadTier("v1");
    await firecrawlScrape(URL_, 8000, { waitForSelector: "#main" });
    const body = sentBody();
    expect(body.actions).toEqual([{ type: "wait", selector: "#main" }]);
    expect(body).not.toHaveProperty("waitFor");
  });

  // Nothing in the live path may move before P4 of the migration, and adding
  // the page-status check to v1 would move it: a v1 backend that returns an
  // error page inside a success envelope is served today, and would start
  // missing.
  it("does not apply the page-status check", async () => {
    mockFetch.mockResolvedValueOnce(scrapeResponse({ statusCode: 404 }));
    const firecrawlScrape = await loadTier("v1");
    await expect(firecrawlScrape(URL_)).resolves.toMatchObject({
      title: "Title",
    });
  });
});
