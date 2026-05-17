import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCurrentTraceId,
  incCounter,
  initObservability,
  recordHistogram,
  withSpan,
} from "../src/observability.js";

describe("observability — no-op mode (OTEL_EXPORTER_OTLP_ENDPOINT unset)", () => {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
  afterEach(() => {
    if (original !== undefined) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
    }
  });

  it("initObservability is a no-op when env var unset (no throw)", async () => {
    await expect(initObservability()).resolves.toBeUndefined();
  });

  it("withSpan runs the wrapped function and returns its value", async () => {
    const out = await withSpan("test_span", { foo: "bar" }, () => 42);
    expect(out).toBe(42);
  });

  it("withSpan propagates exceptions from the wrapped function", async () => {
    await expect(
      withSpan("test_span", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("incCounter and recordHistogram do not throw when no meter is set", () => {
    expect(() => incCounter("search", { profile: "x" })).not.toThrow();
    expect(() =>
      recordHistogram("fetch", 0.5, { tier: "tier1_firecrawl" }),
    ).not.toThrow();
  });

  it("getCurrentTraceId returns undefined when not initialised", () => {
    expect(getCurrentTraceId()).toBeUndefined();
  });
});
