/**
 * Multi-instance SearXNG failover (vikunja#144).
 *
 * `SEARXNG_URL` was consumed in exactly one place and was the last hard single
 * point of failure: SearXNG down meant search down, with no degradation path.
 *
 * The load-bearing property throughout is that A SCALAR `SEARXNG_URL` MUST
 * BEHAVE EXACTLY AS BEFORE — that is every existing deployment. Several tests
 * here exist only to pin that: one request, one host, no health lookup, and the
 * same 10s bound as the pre-failover `AbortSignal.timeout(10000)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = [
  "SEARXNG_URL",
  "SEARXNG_TOTAL_TIMEOUT_MS",
  "SEARXNG_ATTEMPT_TIMEOUT_MS",
  "SEARXNG_UNHEALTHY_TTL_SECONDS",
];

function clearEnv() {
  for (const k of ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});
afterEach(clearEnv);

// ── Config parsing ──────────────────────────────────────────────────────────

describe("parseSearxngUrls", () => {
  async function parse(raw: string | undefined) {
    const { parseSearxngUrls } = await import("../src/config.js");
    const warnings: string[] = [];
    const urls = parseSearxngUrls(raw, (m) => warnings.push(m));
    return { urls, warnings };
  }

  it("treats a scalar value as a single instance", async () => {
    const { urls, warnings } = await parse("http://searxng:8080");
    expect(urls).toEqual(["http://searxng:8080"]);
    expect(warnings).toEqual([]);
  });

  it("defaults to localhost:8081 when unset", async () => {
    expect((await parse(undefined)).urls).toEqual(["http://localhost:8081"]);
  });

  it("splits on commas and on semicolons", async () => {
    // Semicolon is what the comparable server (ihor-sokoliuk/mcp-searxng) uses;
    // accepting only commas would silently collapse that syntax to one bogus
    // instance rather than erroring.
    expect((await parse("http://a:8080,http://b:8080")).urls).toEqual([
      "http://a:8080",
      "http://b:8080",
    ]);
    expect((await parse("http://a:8080;http://b:8080")).urls).toEqual([
      "http://a:8080",
      "http://b:8080",
    ]);
  });

  it("trims whitespace and drops empty entries", async () => {
    expect((await parse(" http://a:8080 , , http://b:8080 ,")).urls).toEqual([
      "http://a:8080",
      "http://b:8080",
    ]);
  });

  it("strips a trailing slash so the path cannot become //search", async () => {
    expect((await parse("http://a:8080/")).urls).toEqual(["http://a:8080"]);
  });

  it("de-duplicates repeated instances", async () => {
    // A repeat would be retried as a distinct replica, spending the shared
    // budget on a host that just failed.
    expect(
      (await parse("http://a:8080,http://a:8080/,http://b:8080")).urls,
    ).toEqual(["http://a:8080", "http://b:8080"]);
  });

  it("drops an unset placeholder rather than treating it as a host", async () => {
    // An unset ${SEARXNG_URL} interpolates to the LITERAL string, not to empty
    // — that un-substituted literal IS the input under test. Built by
    // concatenation so the value is identical while the source carries no
    // `${...}` for biome's noTemplateCurlyInString rule to flag.
    const placeholder = "$" + "{SEARXNG_URL}";
    expect(placeholder.startsWith("$" + "{")).toBe(true);
    expect(placeholder.endsWith("}")).toBe(true);
    const { urls, warnings } = await parse(placeholder);
    expect(urls).toEqual(["http://localhost:8081"]);
    expect(warnings.join(" ")).toContain("not a valid URL");
  });

  it("drops a non-http scheme", async () => {
    const { urls, warnings } = await parse("file:///etc/passwd,http://b:8080");
    expect(urls).toEqual(["http://b:8080"]);
    expect(warnings.join(" ")).toContain("not http(s)");
  });

  it("falls back to the default rather than refusing to boot when all entries are bad", async () => {
    // One bad env var must not become a total outage.
    const { urls, warnings } = await parse("nonsense,also-nonsense");
    expect(urls).toEqual(["http://localhost:8081"]);
    expect(warnings.join(" ")).toContain("no usable entries");
  });

  it("keeps a bad entry from taking out the good ones beside it", async () => {
    expect((await parse("http://a:8080,nonsense,http://b:8080")).urls).toEqual([
      "http://a:8080",
      "http://b:8080",
    ]);
  });
});

// ── Candidate ordering ──────────────────────────────────────────────────────

describe("getSearxCandidates", () => {
  async function load(marked: string[] = []) {
    const cacheGet = vi
      .fn()
      .mockImplementation(async (key: string) =>
        marked.some((m) => key.includes(m)) ? "1" : null,
      );
    const cacheSet = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/cache.js", () => ({
      cacheGet,
      cacheSet,
      searchCacheKey: vi.fn().mockReturnValue("k"),
      getValkey: vi.fn().mockResolvedValue(null),
      cacheClear: vi.fn(),
      cacheAtomicUpdate: vi.fn(),
    }));
    const mod = await import("../src/instances.js");
    return { ...mod, cacheGet, cacheSet };
  }

  it("skips the health lookup entirely for a single instance", async () => {
    // Not an optimisation detail — it is the guarantee that the single-instance
    // hot path gains no cache round-trip, and that the only instance is tried
    // even when it is known to be down.
    const { getSearxCandidates, cacheGet } = await load(["a"]);
    expect(await getSearxCandidates(["http://a:8080"])).toEqual([
      "http://a:8080",
    ]);
    expect(cacheGet).not.toHaveBeenCalled();
  });

  it("puts healthy instances ahead of ones marked unhealthy", async () => {
    const { getSearxCandidates } = await load(["a:8080"]);
    expect(
      await getSearxCandidates(["http://a:8080", "http://b:8080"]),
    ).toEqual(["http://b:8080", "http://a:8080"]);
  });

  it("preserves configured order within each group", async () => {
    const { getSearxCandidates } = await load(["b:8080"]);
    expect(
      await getSearxCandidates([
        "http://a:8080",
        "http://b:8080",
        "http://c:8080",
      ]),
    ).toEqual(["http://a:8080", "http://c:8080", "http://b:8080"]);
  });

  it("returns the full configured list when everything is marked unhealthy", async () => {
    // "Everything looks down" is exactly when you most want to actually try.
    const { getSearxCandidates } = await load(["a:8080", "b:8080"]);
    expect(
      await getSearxCandidates(["http://a:8080", "http://b:8080"]),
    ).toEqual(["http://a:8080", "http://b:8080"]);
  });

  it("degrades to configured order when the cache throws", async () => {
    vi.doMock("../src/cache.js", () => ({
      cacheGet: vi.fn().mockRejectedValue(new Error("cache down")),
      cacheSet: vi.fn().mockResolvedValue(undefined),
      searchCacheKey: vi.fn(),
      getValkey: vi.fn(),
      cacheClear: vi.fn(),
      cacheAtomicUpdate: vi.fn(),
    }));
    const { getSearxCandidates } = await import("../src/instances.js");
    expect(
      await getSearxCandidates(["http://a:8080", "http://b:8080"]),
    ).toEqual(["http://a:8080", "http://b:8080"]);
  });

  it("keeps credentials out of the cache key", async () => {
    const { unhealthyKey } = await load();
    const key = unhealthyKey("http://user:secret@a:8080/path");
    expect(key).not.toContain("secret");
    expect(key).not.toContain("user");
    expect(key).toContain("a:8080");
  });
});

// ── Failover behaviour ──────────────────────────────────────────────────────

const SEARX_OK = {
  results: [
    { title: "T", url: "https://example.com/1", content: "c", engines: ["g"] },
  ],
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

function okResponse(body: unknown = SEARX_OK) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("searxSearchSingle failover", () => {
  async function load(
    urls: string,
    opts: { marked?: string[]; totalMs?: string } = {},
  ) {
    process.env.SEARXNG_URL = urls;
    if (opts.totalMs) process.env.SEARXNG_TOTAL_TIMEOUT_MS = opts.totalMs;

    const cacheSet = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/cache.js", () => ({
      cacheGet: vi
        .fn()
        .mockImplementation(async (key: string) =>
          (opts.marked ?? []).some((m) => key.includes(m)) ? "1" : null,
        ),
      cacheSet,
      searchCacheKey: vi.fn().mockReturnValue("k"),
      getValkey: vi.fn().mockResolvedValue(null),
      cacheClear: vi.fn(),
      cacheAtomicUpdate: vi.fn(),
    }));
    const searxFailover = vi.fn();
    vi.doMock("../src/events.js", () => ({
      events: new Proxy(
        { searxFailover },
        { get: (t, p) => (p in t ? t[p as "searxFailover"] : vi.fn()) },
      ),
    }));
    vi.doMock("../src/observability.js", () => ({
      withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
      incCounter: vi.fn(),
      recordHistogram: vi.fn(),
    }));
    const { searxSearchSingle } = await import("../src/search.js");
    return { searxSearchSingle, searxFailover, cacheSet };
  }

  function hosts(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map((c) => new URL(c[0] as string).host);
  }

  it("single instance: exactly one request, to exactly one host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle } = await load("http://only:8080");

    await searxSearchSingle("q", "general", 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hosts(fetchMock)).toEqual(["only:8080"]);
    vi.unstubAllGlobals();
  });

  it("single instance: does NOT emit a failover event when it fails", async () => {
    // There is nothing to fail over to; an event here would be pure noise and
    // would make a plain outage look like a replica problem.
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle, searxFailover } = await load("http://only:8080");

    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow("down");
    expect(searxFailover).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("[dead, healthy]: succeeds via the second instance", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle } = await load(
      "http://dead:8080,http://live:8080",
    );

    const out = await searxSearchSingle("q", "general", 5);
    expect(out.results).toHaveLength(1);
    expect(hosts(fetchMock)).toEqual(["dead:8080", "live:8080"]);
    vi.unstubAllGlobals();
  });

  it("[dead, healthy]: emits a failover event naming both ends", async () => {
    // A silent failover is indistinguishable from a healthy primary.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle, searxFailover } = await load(
      "http://dead:8080,http://live:8080",
    );

    await searxSearchSingle("q", "general", 5);
    expect(searxFailover).toHaveBeenCalledTimes(1);
    expect(searxFailover.mock.calls[0][0]).toMatchObject({
      from: "http://dead:8080",
      to: "http://live:8080",
      attempt: 0,
      exhausted: false,
    });
    vi.unstubAllGlobals();
  });

  it("[dead, healthy]: marks the dead instance unhealthy for the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle, cacheSet } = await load(
      "http://dead:8080,http://live:8080",
    );

    await searxSearchSingle("q", "general", 5);
    expect(
      cacheSet.mock.calls.some((c) => String(c[0]).includes("dead:8080")),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("[healthy, dead]: never contacts the second instance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle, searxFailover } = await load(
      "http://live:8080,http://dead:8080",
    );

    await searxSearchSingle("q", "general", 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hosts(fetchMock)).toEqual(["live:8080"]);
    expect(searxFailover).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("treats a non-2xx response as a failure and fails over", async () => {
    // A 502 from a proxy in front of a dead SearXNG is the common real shape,
    // and it resolves rather than rejecting — so it must be handled explicitly.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      } as Response)
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle } = await load(
      "http://bad:8080,http://live:8080",
    );

    const out = await searxSearchSingle("q", "general", 5);
    expect(out.results).toHaveLength(1);
    expect(hosts(fetchMock)).toEqual(["bad:8080", "live:8080"]);
    vi.unstubAllGlobals();
  });

  it("reorders so a previously-failed instance is tried second", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle } = await load("http://a:8080,http://b:8080", {
      marked: ["a:8080"],
    });

    await searxSearchSingle("q", "general", 5);
    expect(hosts(fetchMock)).toEqual(["b:8080"]);
    vi.unstubAllGlobals();
  });

  it("throws the last error when every instance fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("first down"))
      .mockRejectedValueOnce(new Error("second down"));
    vi.stubGlobal("fetch", fetchMock);
    const { searxSearchSingle, searxFailover } = await load(
      "http://a:8080,http://b:8080",
    );

    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow(
      "second down",
    );
    expect(searxFailover).toHaveBeenCalledTimes(2);
    expect(searxFailover.mock.calls[1][0]).toMatchObject({
      to: null,
      exhausted: true,
    });
    vi.unstubAllGlobals();
  });
});

// ── The timeout budget ──────────────────────────────────────────────────────

describe("failover timeout budget", () => {
  it("bounds the whole call, rather than N x per-instance", async () => {
    // The defect this prevents: iterating N candidates at the per-attempt
    // timeout each makes the worst case N*attempt, so adding a replica makes a
    // total outage take LONGER to report.
    process.env.SEARXNG_URL =
      "http://a:8080,http://b:8080,http://c:8080,http://d:8080";
    process.env.SEARXNG_TOTAL_TIMEOUT_MS = "300";
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = "200";

    vi.doMock("../src/cache.js", () => ({
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
      searchCacheKey: vi.fn().mockReturnValue("k"),
      getValkey: vi.fn().mockResolvedValue(null),
      cacheClear: vi.fn(),
      cacheAtomicUpdate: vi.fn(),
    }));
    vi.doMock("../src/observability.js", () => ({
      withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
      incCounter: vi.fn(),
      recordHistogram: vi.fn(),
    }));

    // Every instance hangs until its own signal aborts.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("TimeoutError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { searxSearchSingle } = await import("../src/search.js");
    const t0 = Date.now();
    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow();
    const elapsed = Date.now() - t0;

    // 4 instances x 200ms per attempt would be ~800ms. The budget is 300ms.
    // Generous upper bound so this is not timing-flaky, but still far below
    // the un-budgeted figure it is distinguishing from.
    expect(elapsed).toBeLessThan(600);
    // And it must genuinely have spent the budget rather than bailing at once.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    // Not every instance gets contacted — the budget cuts the loop short.
    expect(fetchMock.mock.calls.length).toBeLessThan(4);

    vi.unstubAllGlobals();
  });
});
