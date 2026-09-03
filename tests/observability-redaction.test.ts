/**
 * `withSpan` must not export URL credentials to the collector.
 *
 * A span leaves the host over OTLP, so it is a sink like any other. Node's
 * `fetch` rejects a credentialed URL with a `TypeError` whose message embeds
 * the whole URL, password included, and `withSpan`'s catch block forwards
 * `err.message` into both `recordException` and `setStatus`.
 *
 * This test drives the REAL `withSpan` with a tracer injected through the
 * module's own init path. An earlier attempt mocked `withSpan` and had the mock
 * perform the redaction itself — it stayed green with the production redaction
 * deleted, which made it worthless. The `statuses.length` guard below exists so
 * that a tracer that failed to inject fails the test rather than passing it
 * vacuously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "hunter2";

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe("withSpan credential redaction", () => {
  it("redacts credentials from both the recorded exception and the span status", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";

    const statuses: unknown[] = [];
    const exceptions: Error[] = [];
    const span = {
      setAttributes: () => {},
      recordException: (e: Error) => exceptions.push(e),
      setStatus: (st: unknown) => statuses.push(st),
      end: () => {},
    };
    const noopMeter = {
      createCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
    };

    vi.doMock("@opentelemetry/api", () => ({
      trace: {
        getTracer: () => ({
          startActiveSpan: (_n: string, fn: (s: unknown) => unknown) =>
            fn(span),
        }),
        getActiveSpan: () => undefined,
      },
      metrics: { getMeter: () => noopMeter },
    }));
    vi.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: class {
        start() {}
        shutdown() {
          return Promise.resolve();
        }
      },
    }));
    vi.doMock("@opentelemetry/exporter-trace-otlp-http", () => ({
      OTLPTraceExporter: class {},
    }));
    vi.doMock("@opentelemetry/exporter-metrics-otlp-http", () => ({
      OTLPMetricExporter: class {},
    }));
    vi.doMock("@opentelemetry/sdk-metrics", () => ({
      PeriodicExportingMetricReader: class {},
    }));

    const obs = await import("../src/observability.js");
    await obs.initObservability();

    // The exact shape Node's fetch produces for a credentialed URL.
    const leaky = new TypeError(
      `Request cannot be constructed from a URL that includes credentials: http://admin:${SECRET}@searxng.internal:8080/search?q=x`,
    );
    await expect(
      obs.withSpan("t", {}, async () => {
        throw leaky;
      }),
    ).rejects.toThrow();

    // Guard the guard: without an injected tracer, withSpan no-ops and nothing
    // is recorded, so the two assertions below would pass having tested nothing.
    expect(statuses.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeGreaterThan(0);

    expect(JSON.stringify(statuses)).not.toContain(SECRET);
    expect(exceptions.map((e) => e.message).join(" ")).not.toContain(SECRET);
    // The useful part of the message survives — this is redaction, not deletion.
    expect(JSON.stringify(statuses)).toContain("searxng.internal:8080");
  });
});
