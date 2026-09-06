// vikunja#649 — the HTML format name is a per-version axis, on both the request
// and the response.
//
// v1's format enum is `markdown | rawHtml | screenshot`. Sending `html` to it
// returns a 400 and fails the *entire* scrape, so the unconditional
// `formats: ["markdown", "html"]` this replaces meant every tier-1 request
// failed under FIRECRAWL_API_VERSION=v1. That is latent under the current v2
// deployment and live the moment anyone rolls back — which is a supported
// operation, not a dead branch.
//
// The read side carries the same defect independently: `data.data.html` is
// undefined under v1 even once the request is accepted, so TierResult.html came
// back empty and post-extraction had nothing to work with.

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

/** A backend that answers in `field`, as the real one of that version does. */
function scrapeResponse(field: "html" | "rawHtml", markup: string) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        markdown: "# Title\n\nContent here",
        [field]: markup,
        metadata: { title: "Title", sourceURL: URL_, statusCode: 200 },
      },
    }),
    { status: 200 },
  );
}

async function loadScrape(version: "v1" | "v2") {
  process.env.FIRECRAWL_API_VERSION = version;
  vi.resetModules();
  const { firecrawlScrape } = await import("../../src/tiers/firecrawl.js");
  return firecrawlScrape;
}

function sentFormats(): unknown {
  const init = mockFetch.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body).formats;
}

describe("firecrawlScrape — request format name", () => {
  it("asks v1 for rawHtml, the only HTML format its enum accepts", async () => {
    const scrape = await loadScrape("v1");
    mockFetch.mockResolvedValueOnce(scrapeResponse("rawHtml", "<p>v1</p>"));
    await scrape(URL_);
    expect(sentFormats()).toEqual(["markdown", "rawHtml"]);
  });

  it("asks v2 for html", async () => {
    const scrape = await loadScrape("v2");
    mockFetch.mockResolvedValueOnce(scrapeResponse("html", "<p>v2</p>"));
    await scrape(URL_);
    expect(sentFormats()).toEqual(["markdown", "html"]);
  });

  it("never sends v2's spelling to v1 — this is what 400s the whole scrape", async () => {
    const scrape = await loadScrape("v1");
    mockFetch.mockResolvedValueOnce(scrapeResponse("rawHtml", "<p>v1</p>"));
    await scrape(URL_);
    expect(sentFormats()).not.toContain("html");
  });
});

describe("firecrawlScrape — response field name", () => {
  it("reads rawHtml back from v1", async () => {
    const scrape = await loadScrape("v1");
    mockFetch.mockResolvedValueOnce(
      scrapeResponse("rawHtml", "<h1>from v1</h1>"),
    );
    const result = await scrape(URL_);
    expect(result.html).toBe("<h1>from v1</h1>");
  });

  it("reads html back from v2", async () => {
    const scrape = await loadScrape("v2");
    mockFetch.mockResolvedValueOnce(scrapeResponse("html", "<h1>from v2</h1>"));
    const result = await scrape(URL_);
    expect(result.html).toBe("<h1>from v2</h1>");
  });

  it("does not silently accept the other version's field", async () => {
    // The bug being pinned: a v1 backend answering in `rawHtml` while the
    // reader looked at `html` produced `undefined` rather than an error, so
    // post-extraction degraded quietly instead of failing loudly.
    const scrape = await loadScrape("v1");
    mockFetch.mockResolvedValueOnce(scrapeResponse("html", "<h1>wrong</h1>"));
    const result = await scrape(URL_);
    expect(result.html).toBeUndefined();
  });

  it("still returns markdown text when the HTML field is absent", async () => {
    // html is optional in TierResult; a missing one must not fail the scrape.
    const scrape = await loadScrape("v2");
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: "# Title\n\nContent here",
            metadata: { title: "Title", sourceURL: URL_, statusCode: 200 },
          },
        }),
        { status: 200 },
      ),
    );
    const result = await scrape(URL_);
    expect(result.text).toContain("Content here");
    expect(result.html).toBeUndefined();
  });
});
