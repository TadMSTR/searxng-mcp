// adblock-proxy's retry after a failed startup load (docker/adblock-proxy/proxy.js).
//
// Before 4.0.0 a startup load that installed no engine left the proxy passing
// everything unfiltered, with /health at 503 no_filters, until the next
// scheduled refresh: 168 hours by default. retryStartupLoad() retries with
// backoff (1, 2, 4, 8, 16 minutes, then the ADBLOCK_RETRY_MAX_MINUTES cap)
// until a load succeeds, then stops.

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const PROXY_PATH = "../docker/adblock-proxy/proxy.js";

type FetchImpl = (url: string, init?: unknown) => Promise<Response>;
interface Proxy {
  loadFilters: (opts?: {
    urls?: string[];
    fetchImpl?: FetchImpl;
  }) => Promise<boolean>;
  healthBody: () => { code: number; body: Record<string, unknown> };
  retryDelayMinutes: (attempt: number, maxMinutes?: number) => number;
  parseRetryMaxMinutes: (raw: string | undefined) => number;
  retryStartupLoad: (opts?: {
    load?: () => Promise<unknown>;
    maxMinutes?: number;
  }) => { cancel: () => void };
  state: Record<string, unknown> & { engine: unknown };
}

const proxy = require_(PROXY_PATH) as Proxy;

const FIXTURE = "! fixture\n||ads.example.com^\n||tracker.example.net^\n";
const LIST = "https://lists.test/fixture.txt";
const MIN = 60 * 1000;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(proxy.state, {
    engine: null,
    networkFilters: 0,
    cosmeticFilters: 0,
    loadedAt: null,
    listsFetched: 0,
    listsTotal: 0,
    lists: [],
    lastAttemptAt: null,
    lastAttemptOk: null,
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

const errLines = () => errSpy.mock.calls.map((c) => c.map(String).join(" "));

/** A load that fails `failures` times (upstream down), then serves the fixture. */
function flakyLoad(failures: number) {
  let calls = 0;
  const load = vi.fn(async () => {
    calls += 1;
    const ok = calls > failures;
    return proxy.loadFilters({
      urls: [LIST],
      fetchImpl: ok
        ? async () => new Response(FIXTURE, { status: 200 })
        : async () => {
            throw new Error("getaddrinfo ENOTFOUND lists.test");
          },
    });
  });
  return load;
}

describe("retryDelayMinutes", () => {
  it("doubles from 1 minute and holds at the cap", () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 8].map((a) =>
      proxy.retryDelayMinutes(a, 30),
    );
    expect(seq).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it("honours a lower cap", () => {
    const seq = [1, 2, 3, 4, 5].map((a) => proxy.retryDelayMinutes(a, 5));
    expect(seq).toEqual([1, 2, 4, 5, 5]);
  });
});

describe("retryStartupLoad", () => {
  it("an all-fail start schedules a retry one minute out, then two", async () => {
    const load = flakyLoad(Number.POSITIVE_INFINITY);
    const handle = proxy.retryStartupLoad({ load, maxMinutes: 30 });

    expect(load).not.toHaveBeenCalled();
    expect(errLines().at(-1)).toContain("startup retry 1 in 1 min");

    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(proxy.state.engine).toBeNull();
    expect(errLines().at(-1)).toContain("startup retry 2 in 2 min");

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(load).toHaveBeenCalledTimes(2);
    expect(errLines().at(-1)).toContain("startup retry 3 in 4 min");
    handle.cancel();
  });

  it("a later success installs the engine, turns /health 200 and stops retrying", async () => {
    const load = flakyLoad(2);
    proxy.retryStartupLoad({ load, maxMinutes: 30 });
    expect(proxy.healthBody().code).toBe(503);

    // Attempts at +1 (fail), +3 (fail), +7 (succeeds).
    await vi.advanceTimersByTimeAsync(7 * MIN);
    expect(load).toHaveBeenCalledTimes(3);
    expect(proxy.state.engine).not.toBeNull();
    expect(proxy.healthBody().code).toBe(200);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps retrying at the cap rather than giving up", async () => {
    const load = flakyLoad(Number.POSITIVE_INFINITY);
    const handle = proxy.retryStartupLoad({ load, maxMinutes: 30 });
    // 1+2+4+8+16 = 31 minutes for five attempts, then one every 30.
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(load).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(3 * 30 * MIN);
    expect(load).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(1);
    handle.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing when the startup load already installed an engine", async () => {
    await proxy.loadFilters({
      urls: [LIST],
      fetchImpl: async () => new Response(FIXTURE, { status: 200 }),
    });
    const load = vi.fn();
    proxy.retryStartupLoad({ load });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(load).not.toHaveBeenCalled();
  });

  it("a pending retry does nothing once a refresh has installed an engine", async () => {
    const load = flakyLoad(Number.POSITIVE_INFINITY);
    proxy.retryStartupLoad({ load, maxMinutes: 30 });
    expect(vi.getTimerCount()).toBe(1);
    // The periodic refresh recovers before the first retry fires.
    await proxy.loadFilters({
      urls: [LIST],
      fetchImpl: async () => new Response(FIXTURE, { status: 200 }),
    });
    expect(proxy.state.engine).not.toBeNull();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a load that throws is logged and retried, not fatal", async () => {
    const load = vi.fn(async () => {
      throw new Error("boom\nsecond line");
    });
    const handle = proxy.retryStartupLoad({ load, maxMinutes: 30 });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(errLines()).toContain(
      "[adblock-proxy] startup retry 1 error: boom second line",
    );
    expect(vi.getTimerCount()).toBe(1);
    handle.cancel();
  });
});

describe("ADBLOCK_RETRY_MAX_MINUTES", () => {
  it("never yields a delay setTimeout would clamp to 1 ms", () => {
    for (const raw of ["999999999", "35792", "1441"]) {
      const minutes = proxy.parseRetryMaxMinutes(raw);
      expect(minutes * 60 * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  function freshProxy(value: string | undefined): Proxy {
    const resolved = require_.resolve(PROXY_PATH);
    delete require_.cache[resolved];
    if (value === undefined) vi.stubEnv("ADBLOCK_RETRY_MAX_MINUTES", undefined);
    else vi.stubEnv("ADBLOCK_RETRY_MAX_MINUTES", value);
    try {
      return require_(PROXY_PATH) as Proxy;
    } finally {
      delete require_.cache[resolved];
    }
  }

  it.each([
    [undefined, 30],
    ["5", 5],
    ["0", 30],
    ["-3", 30],
    ["abc", 30],
    ["1440", 1440],
    [" 5 ", 5],
    // Past one day is refused: above ~35,791 minutes setTimeout would clamp
    // the delay to 1 ms and the retry would spin.
    ["1441", 30],
    ["36000", 30],
    ["1e3", 30],
    ["7.5", 30],
  ])("value %s caps the delay at %i minutes", (value, cap) => {
    const p = freshProxy(value);
    expect(p.retryDelayMinutes(20)).toBe(cap);
  });
});
