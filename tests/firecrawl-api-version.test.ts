// FIRECRAWL_API_VERSION: the configuration axis, its startup validation, and
// the single URL helper that stops crawl.ts and tiers/firecrawl.ts from ever
// disagreeing about which backend they are talking to again (vikunja#644).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = ["FIRECRAWL_API_VERSION", "FIRECRAWL_URL", "FIRECRAWL_WAIT_FOR_MS"];

function clearEnv() {
  for (const k of ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});

afterEach(clearEnv);

describe("FIRECRAWL_API_VERSION parsing", () => {
  it("defaults to v1 so the live fetch path does not move on upgrade", async () => {
    const { FIRECRAWL_API_VERSION } = await import("../src/config.js");
    expect(FIRECRAWL_API_VERSION).toBe("v1");
  });

  it("accepts v1", async () => {
    process.env.FIRECRAWL_API_VERSION = "v1";
    const { FIRECRAWL_API_VERSION } = await import("../src/config.js");
    expect(FIRECRAWL_API_VERSION).toBe("v1");
  });

  it("accepts v2", async () => {
    process.env.FIRECRAWL_API_VERSION = "v2";
    const { FIRECRAWL_API_VERSION } = await import("../src/config.js");
    expect(FIRECRAWL_API_VERSION).toBe("v2");
  });

  it("tolerates surrounding whitespace and case", async () => {
    process.env.FIRECRAWL_API_VERSION = "  V2 ";
    const { FIRECRAWL_API_VERSION } = await import("../src/config.js");
    expect(FIRECRAWL_API_VERSION).toBe("v2");
  });

  it("treats an empty value as unset rather than invalid", async () => {
    process.env.FIRECRAWL_API_VERSION = "";
    const { FIRECRAWL_API_VERSION } = await import("../src/config.js");
    expect(FIRECRAWL_API_VERSION).toBe("v1");
  });

  // The point of the whole exercise: a bad value must not construct a URL that
  // 404s forever behind a fallback. Failing at import IS failing at startup for
  // a server whose entrypoint imports config.
  it("throws at import on an unrecognised value", async () => {
    process.env.FIRECRAWL_API_VERSION = "v3";
    await expect(import("../src/config.js")).rejects.toThrow(
      /Invalid FIRECRAWL_API_VERSION/,
    );
  });

  it("names the offending value and the allowed set in the error", async () => {
    process.env.FIRECRAWL_API_VERSION = "latest";
    await expect(import("../src/config.js")).rejects.toThrow(
      /"latest".*Must be one of: v1, v2/s,
    );
  });

  it("rejects a version that merely contains a valid one", async () => {
    process.env.FIRECRAWL_API_VERSION = "v2beta";
    await expect(import("../src/config.js")).rejects.toThrow(
      /Invalid FIRECRAWL_API_VERSION/,
    );
  });
});

describe("firecrawlEndpoint", () => {
  it("builds v1 paths by default", async () => {
    process.env.FIRECRAWL_URL = "http://fc:3002";
    const { firecrawlEndpoint } = await import("../src/firecrawl-api.js");
    expect(firecrawlEndpoint("scrape")).toBe("http://fc:3002/v1/scrape");
    expect(firecrawlEndpoint("crawl")).toBe("http://fc:3002/v1/crawl");
    expect(firecrawlEndpoint("crawl/abc123")).toBe(
      "http://fc:3002/v1/crawl/abc123",
    );
  });

  it("builds v2 paths when configured for v2", async () => {
    process.env.FIRECRAWL_URL = "http://fc:3002";
    process.env.FIRECRAWL_API_VERSION = "v2";
    const { firecrawlEndpoint } = await import("../src/firecrawl-api.js");
    expect(firecrawlEndpoint("scrape")).toBe("http://fc:3002/v2/scrape");
    expect(firecrawlEndpoint("map")).toBe("http://fc:3002/v2/map");
  });

  it("does not double the separator when the path carries a leading slash", async () => {
    process.env.FIRECRAWL_URL = "http://fc:3002";
    const { firecrawlEndpoint } = await import("../src/firecrawl-api.js");
    expect(firecrawlEndpoint("/scrape")).toBe("http://fc:3002/v1/scrape");
  });

  it("takes an explicit version override", async () => {
    process.env.FIRECRAWL_URL = "http://fc:3002";
    const { firecrawlEndpoint } = await import("../src/firecrawl-api.js");
    expect(firecrawlEndpoint("scrape", "v2")).toBe("http://fc:3002/v2/scrape");
  });
});

describe("backend capability predicates", () => {
  it("reports actions supported under v1 only", async () => {
    const { firecrawlSupportsActions } = await import(
      "../src/firecrawl-api.js"
    );
    expect(firecrawlSupportsActions("v1")).toBe(true);
    expect(firecrawlSupportsActions("v2")).toBe(false);
  });

  it("reports map available under v2 only", async () => {
    const { firecrawlSupportsMap } = await import("../src/firecrawl-api.js");
    expect(firecrawlSupportsMap("v1")).toBe(false);
    expect(firecrawlSupportsMap("v2")).toBe(true);
  });

  it("defaults both predicates from the configured version", async () => {
    process.env.FIRECRAWL_API_VERSION = "v2";
    const { firecrawlSupportsActions, firecrawlSupportsMap } = await import(
      "../src/firecrawl-api.js"
    );
    expect(firecrawlSupportsActions()).toBe(false);
    expect(firecrawlSupportsMap()).toBe(true);
  });
});
