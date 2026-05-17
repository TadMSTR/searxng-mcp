import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, initEvents, publishEvent } from "../src/events.js";

describe("events — no-op mode (NATS_URL unset)", () => {
  const original = process.env.NATS_URL;
  beforeEach(() => {
    delete process.env.NATS_URL;
  });
  afterEach(() => {
    if (original !== undefined) {
      process.env.NATS_URL = original;
    }
  });

  it("initEvents is a no-op when env var unset", async () => {
    await expect(initEvents()).resolves.toBeUndefined();
  });

  it("publishEvent does not throw when not connected", () => {
    expect(() => publishEvent("test.subject", { foo: "bar" })).not.toThrow();
  });

  it("typed shortcuts do not throw when not connected", () => {
    expect(() =>
      events.searchRequested({ query: "q", num_results: 5 }),
    ).not.toThrow();
    expect(() =>
      events.searchCompleted({
        result_count: 3,
        latency_ms: 100,
        rerank_applied: true,
      }),
    ).not.toThrow();
    expect(() =>
      events.fetchRequested({ url: "https://example.com", max_chars: 8000 }),
    ).not.toThrow();
    expect(() =>
      events.fetchTierMiss({
        url: "https://example.com",
        tier: "tier1_firecrawl",
        reason: "miss",
        latency_ms: 12,
      }),
    ).not.toThrow();
    expect(() =>
      events.fetchCompleted({
        url: "https://example.com",
        tier_served: "tier1_firecrawl",
        title: "T",
        text_len: 100,
        latency_ms: 50,
      }),
    ).not.toThrow();
    expect(() =>
      events.cacheHit({ key_type: "get", namespace: "fetch" }),
    ).not.toThrow();
    expect(() =>
      events.cacheMiss({ key_type: "get", namespace: "fetch" }),
    ).not.toThrow();
    expect(() =>
      events.error({
        stage: "fetch",
        url: "https://x",
        error_type: "ETIMEDOUT",
        message: "timeout",
      }),
    ).not.toThrow();
  });
});
