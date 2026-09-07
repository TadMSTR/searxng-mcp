// CACHE_URL="" and RERANKER_URL="" must actually disable the call, not just
// flip the startup capability line.
//
// Both env vars have non-empty defaults in src/config.ts and no kill switch, so
// an empty string is the ONLY way to turn either off — which is exactly what
// examples/compose.minimal.yml does to get a clean minimal run. Before the
// guards these tests cover, "" turned the capability line to `off` while the
// process kept calling: the cache client fell through to ioredis's own default
// of 127.0.0.1:6379 (an address in no configuration anywhere), and the reranker
// issued fetch("/v1/rerank"), a relative URL that throws on every search.
//
// Both failed soft, so results stayed correct and nothing was obviously broken.
// That is what made it worth a test rather than a fix: the symptom is a log
// line and a wasted round trip, which is precisely the kind of thing that
// survives for ten releases (cf. vikunja#680, vikunja#695).
//
// Asserting on the ABSENCE of a call, so each test needs a matching positive
// control proving the call happens when the URL is set — otherwise a broken
// harness that never calls anything would pass both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { ctorCalls: [] as string[] };
  class MockRedis {
    constructor(url: string, _options: Record<string, unknown>) {
      state.ctorCalls.push(url);
    }
    on(): this {
      return this;
    }
    defineCommand(): void {}
    async connect(): Promise<void> {}
    disconnect(): void {}
    async get(): Promise<string | null> {
      return null;
    }
    async ping(): Promise<string> {
      return "PONG";
    }
  }
  return { state, MockRedis };
});

vi.mock("iovalkey", () => ({ Redis: h.MockRedis }));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  h.state.ctorCalls.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CACHE_URL="" disables the cache client', () => {
  it("constructs no client at all", async () => {
    vi.stubEnv("CACHE_URL", "");
    const { cacheGet } = await import("../src/cache.js");
    expect(await cacheGet("search:abc")).toBeNull();
    expect(h.state.ctorCalls).toHaveLength(0);
  });

  it("reports the backend as down without dialling anything", async () => {
    vi.stubEnv("CACHE_URL", "");
    const { cachePing } = await import("../src/cache.js");
    expect(await cachePing()).toBe(false);
    expect(h.state.ctorCalls).toHaveLength(0);
  });

  // Positive control. Without this, a harness that never reached the
  // constructor for any reason would satisfy both assertions above.
  it("POSITIVE CONTROL: a non-empty CACHE_URL still constructs a client", async () => {
    vi.stubEnv("CACHE_URL", "redis://cache.example:6379");
    const { cacheGet } = await import("../src/cache.js");
    await cacheGet("search:abc");
    expect(h.state.ctorCalls).toEqual(["redis://cache.example:6379"]);
  });
});

describe('RERANKER_URL="" disables the reranker call', () => {
  const results = [
    { title: "a", url: "https://example.com/a", content: "first" },
    { title: "b", url: "https://example.com/b", content: "second" },
  ];

  it("issues no fetch and returns the upstream order, truncated to topN", async () => {
    vi.stubEnv("RERANKER_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { rerankWithFallback } = await import("../src/reranker.js");
    const out = await rerankWithFallback("q", results, 1);

    expect(fetchSpy).not.toHaveBeenCalled();
    // Upstream order preserved, and topN honoured rather than ignored.
    expect(out).toEqual([results[0]]);
  });

  it("POSITIVE CONTROL: a non-empty RERANKER_URL does issue the fetch", async () => {
    vi.stubEnv("RERANKER_URL", "http://reranker.example:8787");
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const { rerankWithFallback } = await import("../src/reranker.js");
    const out = await rerankWithFallback("q", results, 2);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://reranker.example:8787/v1/rerank",
    );
    // Reordered, so this is asserting the reranker ran rather than that a
    // fallback happened to return something.
    expect(out.map((r) => r.url)).toEqual([results[1].url, results[0].url]);
  });
});
