// publishEvent and shutdownEvents: the fire-and-forget guarantees.
//
// Every searxng-mcp tool call passes through these hooks. The contract is that
// they can never affect the caller — no throw, no rejection, no observable
// delay — because an event bus outage must not become a failed search. That is
// easy to write and easy to regress, since nothing downstream notices when it
// breaks; the events simply stop, silently.
//
// events.test.ts and events-auth.test.ts cover connection setup. These cover
// what happens on the publish path afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    published: [] as Array<{ subject: string; data: string }>,
    throwOnPublish: null as Error | null,
    throwOnDrain: null as Error | null,
    drained: 0,
    connectError: null as Error | null,
  };
  return { state };
});

vi.mock("@nats-io/transport-node", () => ({
  connect: async () => {
    if (h.state.connectError) throw h.state.connectError;
    return {
      publish: (subject: string, data: Uint8Array) => {
        if (h.state.throwOnPublish) throw h.state.throwOnPublish;
        h.state.published.push({
          subject,
          data: new TextDecoder().decode(data),
        });
      },
      drain: async () => {
        h.state.drained++;
        if (h.state.throwOnDrain) throw h.state.throwOnDrain;
      },
    };
  },
}));
vi.mock("@nats-io/nats-core", () => ({ credsAuthenticator: () => ({}) }));
vi.mock("../src/context.js", () => ({ getRequestId: () => "req-1" }));
vi.mock("../src/observability.js", () => ({
  getCurrentTraceId: () => "trace-1",
}));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  Object.assign(h.state, {
    throwOnPublish: null,
    throwOnDrain: null,
    drained: 0,
    connectError: null,
  });
  h.state.published.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

async function connected(prefix?: string) {
  vi.stubEnv("NATS_URL", "nats://nats.example:4222");
  if (prefix !== undefined) vi.stubEnv("NATS_SUBJECT_PREFIX", prefix);
  const m = await import("../src/events.js");
  await m.initEvents();
  return m;
}

describe("publishEvent — with no connection", () => {
  it("is a silent no-op when NATS is not configured", async () => {
    vi.stubEnv("NATS_URL", "");
    const m = await import("../src/events.js");
    await m.initEvents();
    expect(() => m.publishEvent("search.requested", { a: 1 })).not.toThrow();
    expect(h.state.published).toHaveLength(0);
  });

  it("is a no-op after a failed connect, and warns exactly once", async () => {
    h.state.connectError = new Error("ECONNREFUSED");
    vi.stubEnv("NATS_URL", "nats://nats.example:4222");
    const m = await import("../src/events.js");
    await m.initEvents();
    await m.initEvents();
    expect(() => m.publishEvent("x", {})).not.toThrow();
    expect(h.state.published).toHaveLength(0);
    // One line, not one per attempt: a reconnect loop must not flood the log.
    const warnings = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("NATS connect failed"));
    expect(warnings).toHaveLength(1);
  });
});

describe("publishEvent — connected", () => {
  it("publishes under the default subject prefix with a full envelope", async () => {
    const m = await connected();
    m.publishEvent("search.requested", { query: "q" });
    expect(h.state.published).toHaveLength(1);
    expect(h.state.published[0].subject).toBe("searxng.search.requested");
    const body = JSON.parse(h.state.published[0].data);
    expect(body).toMatchObject({
      query: "q",
      request_id: "req-1",
      trace_id: "trace-1",
    });
    // ts must be a real ISO timestamp, not the string "undefined".
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it("honours NATS_SUBJECT_PREFIX", async () => {
    const m = await connected("forge");
    m.publishEvent("fetch.requested", {});
    expect(h.state.published[0].subject).toBe("forge.fetch.requested");
  });

  it("never throws when publish itself throws", async () => {
    // The whole point of the module: a broken bus cannot fail a search.
    const m = await connected();
    h.state.throwOnPublish = new Error("connection draining");
    expect(() => m.publishEvent("search.requested", { q: 1 })).not.toThrow();
  });

  it("never throws on a payload that cannot be serialised", async () => {
    const m = await connected();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => m.publishEvent("search.requested", circular)).not.toThrow();
    expect(h.state.published).toHaveLength(0);
  });

  it("routes every typed shortcut to its documented subject", async () => {
    const m = await connected();
    m.events.searchRequested({ query: "q", num_results: 5 });
    m.events.searchCompleted({
      result_count: 5,
      latency_ms: 12,
      rerank_applied: true,
    });
    m.events.fetchRequested({ url: "https://e/x", max_chars: 100 });
    m.events.fetchTierMiss({
      url: "https://e/x",
      tier: "tier1",
      reason: "empty",
      latency_ms: 3,
    });
    m.events.fetchTierSkipped({
      url: "https://e/x",
      tier: "tier2",
      reason: "not_configured",
    });
    expect(h.state.published.map((p) => p.subject)).toEqual([
      "searxng.search.requested",
      "searxng.search.completed",
      "searxng.fetch.requested",
      "searxng.fetch.tier.miss",
      "searxng.fetch.tier.skipped",
    ]);
  });
});

describe("shutdownEvents", () => {
  it("is a no-op when never connected", async () => {
    vi.stubEnv("NATS_URL", "");
    const m = await import("../src/events.js");
    await expect(m.shutdownEvents()).resolves.toBeUndefined();
    expect(h.state.drained).toBe(0);
  });

  it("drains the connection so buffered events are flushed, not discarded", async () => {
    // drain(), not close(): close would throw away exactly the events a
    // shutdown is most likely to be carrying.
    const m = await connected();
    await m.shutdownEvents();
    expect(h.state.drained).toBe(1);
  });

  it("swallows a drain error and still clears the connection", async () => {
    const m = await connected();
    h.state.throwOnDrain = new Error("already closed");
    await expect(m.shutdownEvents()).resolves.toBeUndefined();
    // Cleared, so a later publish no-ops rather than using a dead connection.
    m.publishEvent("x", {});
    expect(h.state.published).toHaveLength(0);
  });
});
