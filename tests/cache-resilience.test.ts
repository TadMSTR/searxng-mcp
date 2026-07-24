import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock iovalkey so we can drive connect/get/ping outcomes without a real cache
// backend, and inspect the client options the resilience fix passes.
const h = vi.hoisted(() => {
  const state = {
    ctorOptions: [] as Array<Record<string, unknown>>,
    connectError: null as Error | null,
    getError: null as Error | null,
    getResult: null as string | null,
    pingResult: "PONG" as string,
    pingError: null as Error | null,
  };
  class MockRedis {
    constructor(_url: string, options: Record<string, unknown>) {
      state.ctorOptions.push(options);
    }
    on(): this {
      return this;
    }
    async connect(): Promise<void> {
      if (state.connectError) throw state.connectError;
    }
    disconnect(): void {}
    async get(): Promise<string | null> {
      if (state.getError) throw state.getError;
      return state.getResult;
    }
    async ping(): Promise<string> {
      if (state.pingError) throw state.pingError;
      return state.pingResult;
    }
  }
  return { state, MockRedis };
});

vi.mock("iovalkey", () => ({ Redis: h.MockRedis }));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  h.state.ctorOptions.length = 0;
  h.state.connectError = null;
  h.state.getError = null;
  h.state.getResult = null;
  h.state.pingResult = "PONG";
  h.state.pingError = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

describe("cache resilience", () => {
  it("constructs the client with bounded command/connect timeouts and retries", async () => {
    const { cacheGet } = await import("../src/cache.js");
    await cacheGet("search:abc");
    expect(h.state.ctorOptions).toHaveLength(1);
    expect(h.state.ctorOptions[0]).toMatchObject({
      commandTimeout: 2500,
      connectTimeout: 3000,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableReadyCheck: false,
    });
  });

  it("cacheGet fails soft (returns null) and logs when a command times out", async () => {
    h.state.getError = new Error("Command timed out");
    const { cacheGet } = await import("../src/cache.js");
    const value = await cacheGet("search:abc");
    expect(value).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[searxng-mcp] cache get failed"),
    );
  });

  it("cacheGet logs and returns null when the client cannot connect", async () => {
    h.state.connectError = new Error("ECONNREFUSED");
    const { cacheGet } = await import("../src/cache.js");
    const value = await cacheGet("search:abc");
    expect(value).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[searxng-mcp] cache connect failed"),
    );
  });

  it("cachePing returns true on PONG", async () => {
    const { cachePing } = await import("../src/cache.js");
    expect(await cachePing()).toBe(true);
  });

  it("cachePing returns false when the cache is unreachable", async () => {
    h.state.connectError = new Error("ECONNREFUSED");
    const { cachePing } = await import("../src/cache.js");
    expect(await cachePing()).toBe(false);
  });

  it("cachePing returns false when ping itself errors (does not throw)", async () => {
    h.state.pingError = new Error("Command timed out");
    const { cachePing } = await import("../src/cache.js");
    await expect(cachePing()).resolves.toBe(false);
  });
});
