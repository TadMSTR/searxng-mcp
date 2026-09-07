// Coverage for the compare-and-set write path and cacheClear's scan loop.
//
// These are the branches that only fire under contention or against a
// multi-page keyspace, so example tests written against a quiet local Valkey
// never reach them: a CAS conflict, an exhausted retry budget, and a SCAN that
// returns a non-zero cursor. All three are silent by design — the write is
// dropped best-effort — which is exactly why they need assertions rather than
// an operator noticing later that a field stopped updating.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    // Scripted casSet outcomes, consumed in order; anything past the end
    // returns the last value.
    casResults: [] as number[],
    casCalls: [] as Array<{
      key: string;
      exists: string;
      expected: string;
      updated: string;
    }>,
    getValues: [] as Array<string | null>,
    getCalls: 0,
    throwOnGet: null as Error | null,
    throwOnCas: null as Error | null,
    scanPages: [] as Array<[string, string[]]>,
    scanCalls: [] as string[],
    delCalls: [] as string[][],
    throwOnScan: null as Error | null,
  };
  class MockRedis {
    // No constructor: this mock does not assert on the client options. The
    // constructor-argument assertions live in cache-resilience.test.ts (client
    // timeouts) and disable-switches.test.ts (the URL actually dialled).
    on(): this {
      return this;
    }
    defineCommand(): void {}
    async connect(): Promise<void> {}
    disconnect(): void {}
    async ping(): Promise<string> {
      return "PONG";
    }
    async get(): Promise<string | null> {
      if (state.throwOnGet) throw state.throwOnGet;
      const v =
        state.getValues[Math.min(state.getCalls, state.getValues.length - 1)];
      state.getCalls++;
      return v ?? null;
    }
    async casSet(
      key: string,
      exists: string,
      expected: string,
      updated: string,
    ): Promise<number> {
      if (state.throwOnCas) throw state.throwOnCas;
      state.casCalls.push({ key, exists, expected, updated });
      const i = state.casCalls.length - 1;
      return state.casResults[Math.min(i, state.casResults.length - 1)] ?? 1;
    }
    async scan(cursor: string): Promise<[string, string[]]> {
      if (state.throwOnScan) throw state.throwOnScan;
      state.scanCalls.push(cursor);
      const page = state.scanPages[state.scanCalls.length - 1];
      return page ?? ["0", []];
    }
    async del(keys: string[]): Promise<number> {
      state.delCalls.push(keys);
      return keys.length;
    }
    async set(): Promise<string> {
      return "OK";
    }
  }
  return { state, MockRedis };
});

vi.mock("iovalkey", () => ({ Redis: h.MockRedis }));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  Object.assign(h.state, {
    casResults: [],
    casCalls: [],
    getValues: [],
    getCalls: 0,
    throwOnGet: null,
    throwOnCas: null,
    scanPages: [],
    scanCalls: [],
    delCalls: [],
    throwOnScan: null,
  });
  h.state.casCalls.length = 0;
  h.state.scanCalls.length = 0;
  h.state.delCalls.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("cacheAtomicUpdate — compare-and-set", () => {
  it("commits on the first attempt when nothing else is writing", async () => {
    h.state.getValues = [null];
    h.state.casResults = [1];
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await cacheAtomicUpdate("domain:example.com", 60, () => "written");
    expect(h.state.casCalls).toHaveLength(1);
    // A null read must be signalled as "key does not exist" (exists flag "0"),
    // or the Lua script would compare against an empty string and clobber a key
    // that appeared in between.
    expect(h.state.casCalls[0].exists).toBe("0");
    expect(h.state.casCalls[0].updated).toBe("written");
  });

  it("passes exists=1 and the prior value when the key already exists", async () => {
    h.state.getValues = ["prior"];
    h.state.casResults = [1];
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await cacheAtomicUpdate("domain:example.com", 60, (raw) => `${raw}+new`);
    expect(h.state.casCalls[0].exists).toBe("1");
    expect(h.state.casCalls[0].expected).toBe("prior");
    expect(h.state.casCalls[0].updated).toBe("prior+new");
  });

  it("re-reads and re-applies the mutation when another writer wins the race", async () => {
    // First CAS loses (0), second wins (1). The mutation must be applied to the
    // value read on the SECOND pass, not re-committed from the stale first read
    // — that is the whole point of compare-and-set over get-then-set.
    h.state.getValues = ["v1", "v2"];
    h.state.casResults = [0, 1];
    const seen: Array<string | null> = [];
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await cacheAtomicUpdate("domain:example.com", 60, (raw) => {
      seen.push(raw);
      return `${raw}!`;
    });
    expect(h.state.casCalls).toHaveLength(2);
    expect(seen).toEqual(["v1", "v2"]);
    expect(h.state.casCalls[1].expected).toBe("v2");
    expect(h.state.casCalls[1].updated).toBe("v2!");
  });

  it("gives up after maxRetries under sustained contention, and says so", async () => {
    h.state.getValues = ["v"];
    h.state.casResults = [0]; // never commits
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await cacheAtomicUpdate("domain:example.com", 60, (raw) => `${raw}!`, 3);
    expect(h.state.casCalls).toHaveLength(3);
    // The drop must be visible. It was previously unreachable and therefore
    // silent; a starved field showing up months later is the failure mode.
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toMatch(/gave up after 3 attempts/);
  });

  it("stops on the first exception rather than burning the retry budget", async () => {
    h.state.getValues = ["v"];
    h.state.throwOnCas = new Error("connection reset");
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await expect(
      cacheAtomicUpdate("domain:example.com", 60, () => "x", 3),
    ).resolves.toBeUndefined();
    // Exactly one attempt: the catch returns rather than looping. Documented
    // best-effort behaviour, pinned so a "helpful" retry-on-exception change is
    // a deliberate one.
    expect(h.state.getCalls).toBe(1);
  });

  it("never throws when the mutate function itself throws", async () => {
    h.state.getValues = [null];
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    await expect(
      cacheAtomicUpdate("domain:example.com", 60, () => {
        throw new Error("bad mutation");
      }),
    ).resolves.toBeUndefined();
  });

  it("serialises concurrent updates to the same key", async () => {
    // The in-flight map exists so two updates to one key cannot interleave
    // their read-modify-write. Without it both would read the same value and
    // one would be lost.
    h.state.getValues = ["a", "b"];
    h.state.casResults = [1];
    const { cacheAtomicUpdate } = await import("../src/cache.js");
    const order: string[] = [];
    const p1 = cacheAtomicUpdate("domain:x", 60, (raw) => {
      order.push(`first:${raw}`);
      return "1";
    });
    const p2 = cacheAtomicUpdate("domain:x", 60, (raw) => {
      order.push(`second:${raw}`);
      return "2";
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first:a", "second:b"]);
  });
});

describe("cacheClear — SCAN pagination", () => {
  it("follows a non-zero cursor across pages and deletes the union", async () => {
    // A single-page mock cannot distinguish a correct loop from one that
    // returns after the first batch — this is the case that does.
    h.state.scanPages = [
      ["17", ["search:a", "search:b"]],
      ["42", ["search:c"]],
      ["0", ["search:d"]],
    ];
    const { cacheClear } = await import("../src/cache.js");
    const n = await cacheClear("search:*");
    expect(h.state.scanCalls).toEqual(["0", "17", "42"]);
    expect(n).toBe(4);
    expect(h.state.delCalls).toEqual([
      ["search:a", "search:b", "search:c", "search:d"],
    ]);
  });

  it("returns 0 and issues no DEL when the pattern matches nothing", async () => {
    h.state.scanPages = [["0", []]];
    const { cacheClear } = await import("../src/cache.js");
    expect(await cacheClear("search:*")).toBe(0);
    // A DEL with an empty key list is an error in Redis, so this is a real
    // guard rather than an optimisation.
    expect(h.state.delCalls).toHaveLength(0);
  });

  it("returns 0 rather than throwing when the backend errors mid-scan", async () => {
    h.state.throwOnScan = new Error("LOADING Redis is loading the dataset");
    const { cacheClear } = await import("../src/cache.js");
    expect(await cacheClear("search:*")).toBe(0);
  });

  it("returns 0 when no cache is configured at all", async () => {
    vi.stubEnv("CACHE_URL", "");
    const { cacheClear } = await import("../src/cache.js");
    expect(await cacheClear("search:*")).toBe(0);
    expect(h.state.scanCalls).toHaveLength(0);
  });
});
