// vikunja#691 — the tokenless-auth-failure warning.
//
// Its own file because it needs CRAWL4AI_API_TOKEN mocked absent, which is the
// opposite of what the other crawl4ai suites want, and vi.mock is per-file.
//
// Why this warning exists, reproduced on a scratch 0.9.3: started with no
// CRAWL4AI_API_TOKEN, the container reported `Up 45 seconds (healthy)`, its own
// loopback answered `{"status":"ok","version":"0.9.3"}`, and the published port
// gave curl exit 56 — connection reset. /health is unauthenticated even when a
// token IS set, so no healthcheck at any layer can tell the difference.
//
// It fires on an observed failure, not on the target-version constant. The
// pre-emptive version was built first and rejected: this client ships before
// the server upgrade, so it warned on every crawl against the healthy 0.8.6
// that is actually deployed. The no-false-alarm case below is that regression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  CRAWL4AI_URL: "http://crawl4ai:11235",
  CRAWL4AI_API_TOKEN: undefined,
  ADBLOCK_PROXY_URL: null,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  CRAWL4AI_TARGET_VERSION,
  crawl4aiFetch,
  resetCrawl4aiTokenWarning,
} from "../../src/tiers/crawl4ai.js";

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetCrawl4aiTokenWarning();
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  spy.mockRestore();
});

const okResponse = () =>
  new Response(
    JSON.stringify({
      results: [
        { markdown: { raw_markdown: "content" }, metadata: { title: "T" } },
      ],
    }),
    { status: 200 },
  );

const unauthorized = () =>
  new Response(JSON.stringify({ detail: "Authentication required" }), {
    status: 401,
  });

describe("tokenless auth-failure warning", () => {
  it("only matters because the version targeted is a 0.9.x", () => {
    // Guards the guard: if the constant is rolled back to 0.8.x, this file is
    // asserting a branch that no longer matters and should say so.
    expect(CRAWL4AI_TARGET_VERSION).toMatch(/^0\.9\./);
  });

  it("warns on an observed 401 when no token is configured", async () => {
    mockFetch.mockResolvedValueOnce(unauthorized());
    await expect(crawl4aiFetch("https://example.com")).rejects.toThrow(/401/);

    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain("CRAWL4AI_API_TOKEN");
    // The three facts that make it actionable rather than noise.
    expect(msg).toContain(CRAWL4AI_TARGET_VERSION);
    expect(msg).toMatch(/connection reset/i);
    expect(msg).toMatch(/healthy/i);
  });

  it("warns on a connection reset — the shape with no 401 to observe", async () => {
    // The primary failure mode: a tokenless 0.9.x binds container-loopback, so
    // there is no HTTP status at all, only a reset. Asserting the 401 path
    // alone would leave this one unproven.
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      }),
    );
    await expect(crawl4aiFetch("https://example.com")).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("CRAWL4AI_API_TOKEN");
  });

  it("does NOT warn when the tokenless request succeeds", async () => {
    // The regression that killed the pre-emptive design. A tokenless client
    // against the deployed 0.8.6 works, and must stay silent — a warning on a
    // healthy system is how the signal gets ignored before it matters.
    mockFetch.mockResolvedValueOnce(okResponse());
    const result = await crawl4aiFetch("https://example.com");

    expect(result?.text).toBe("content");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not warn on a failure that is not auth-shaped", async () => {
    // A 500 says nothing about the token; claiming it does would send the
    // reader after the wrong cause.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
      }),
    );
    await expect(crawl4aiFetch("https://example.com")).rejects.toThrow(/500/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("warns once, not on every failed crawl", async () => {
    // Fresh Response per call — one instance has its body stream locked after
    // the first read and the later crawls would fail for the wrong reason.
    mockFetch.mockImplementation(async () => unauthorized());
    for (const u of [
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]) {
      await expect(crawl4aiFetch(u)).rejects.toThrow(/401/);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports the 401 once, without double-wrapping the message", async () => {
    // Observed live against the scratch 0.9.3 before this was fixed:
    // "Crawl4AI: Crawl4AI error: 401 Authentication required".
    mockFetch.mockResolvedValueOnce(unauthorized());
    const err = (await crawl4aiFetch("https://example.com").catch(
      (e: Error) => e,
    )) as Error;

    expect(err.message).toContain("Crawl4AI error: 401");
    expect(err.message).not.toMatch(/Crawl4AI.*Crawl4AI error/);
  });
});
