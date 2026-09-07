// withSpan's error path, which is a SECURITY sink and not merely instrumentation.
//
// A span is exported off-host over OTLP. Node's own fetch embeds the full URL —
// credentials included — in its TypeError messages, so an unredacted
// recordException ships a Basic Auth password to the collector. The redaction
// exists for that; these tests are what stop it being refactored away as
// defensive noise, since nothing else in the suite instantiates a tracer.
//
// The whole module no-ops without OTEL_EXPORTER_OTLP_ENDPOINT, so the OTel
// packages are mocked and initObservability is driven directly. Everything
// here uses a fake tracer — nothing is exported anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Recorded = {
  exceptions: Error[];
  statuses: Array<{ code: number; message?: string }>;
  attrs: Array<Record<string, unknown>>;
};

function fakeOtel(rec: Recorded, ended: { count: number }) {
  const span = {
    setAttributes: (a: Record<string, unknown>) => rec.attrs.push(a),
    recordException: (e: Error) => rec.exceptions.push(e),
    setStatus: (s: { code: number; message?: string }) => rec.statuses.push(s),
    end: () => {
      ended.count++;
    },
    spanContext: () => ({ traceId: "abc123traceid" }),
  };
  return {
    api: {
      trace: {
        getTracer: () => ({
          // startActiveSpan(name, fn) — the two-arg overload withSpan uses.
          startActiveSpan: (_n: string, fn: (s: unknown) => unknown) =>
            fn(span),
        }),
        getActiveSpan: () => span,
      },
      metrics: {
        getMeter: () => ({
          createCounter: () => ({ add: vi.fn() }),
          createHistogram: () => ({ record: vi.fn() }),
        }),
      },
      SpanStatusCode: { OK: 1, ERROR: 2 },
    },
    span,
  };
}

let rec: Recorded;
let ended: { count: number };
let errSpy: ReturnType<typeof vi.spyOn>;

async function loadWithTracer() {
  const { api } = fakeOtel(rec, ended);
  vi.resetModules();
  vi.doMock("@opentelemetry/api", () => api);
  vi.doMock("@opentelemetry/sdk-node", () => ({
    NodeSDK: class {
      start() {}
      async shutdown() {}
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
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
  const m = await import("../src/observability.js");
  await m.initObservability();
  return m;
}

beforeEach(() => {
  rec = { exceptions: [], statuses: [], attrs: [] };
  ended = { count: 0 };
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("withSpan — no tracer configured", () => {
  it("runs the callback with an undefined span and returns its value", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.resetModules();
    const { withSpan, getCurrentTraceId } = await import(
      "../src/observability.js"
    );
    const seen: unknown[] = [];
    const out = await withSpan("op", { a: 1 }, (span) => {
      seen.push(span);
      return "value";
    });
    expect(out).toBe("value");
    expect(seen).toEqual([undefined]);
    expect(getCurrentTraceId()).toBeUndefined();
  });

  it("propagates a throw untouched when there is no tracer", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.resetModules();
    const { withSpan } = await import("../src/observability.js");
    await expect(
      withSpan("op", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("withSpan — with a tracer", () => {
  it("returns the callback's value and ends the span", async () => {
    const { withSpan } = await loadWithTracer();
    expect(await withSpan("op", { a: 1 }, async () => 7)).toBe(7);
    expect(ended.count).toBe(1);
  });

  it("drops undefined attributes but keeps falsy defined ones", async () => {
    const { withSpan } = await loadWithTracer();
    await withSpan(
      "op",
      { kept: "yes", dropped: undefined, n: 0, f: false },
      () => 1,
    );
    expect(rec.attrs).toHaveLength(1);
    // cleanAttrs filters on `!== undefined`, not on truthiness. Dropping 0 and
    // false alongside undefined is the slip this pins — and a zero silently
    // missing from a span is indistinguishable from a metric that was never
    // recorded.
    expect(rec.attrs[0]).toEqual({ kept: "yes", n: 0, f: false });
    expect("dropped" in rec.attrs[0]).toBe(false);
  });

  it("REDACTS credentials from the exception it records", async () => {
    const { withSpan } = await loadWithTracer();
    const leaky = new Error(
      "fetch failed for https://user:hunter2@searx.internal/search?q=x",
    );
    leaky.name = "TypeError";
    await expect(
      withSpan("op", {}, () => {
        throw leaky;
      }),
    ).rejects.toBe(leaky);

    expect(rec.exceptions).toHaveLength(1);
    const recorded = rec.exceptions[0];
    expect(recorded.message).not.toContain("hunter2");
    expect(recorded.message).not.toContain("user:hunter2");
    // The name is preserved so the exporter still shows a TypeError.
    expect(recorded.name).toBe("TypeError");
    // The host is not a secret and stays, or the span becomes useless.
    expect(recorded.message).toContain("searx.internal");
  });

  it("redacts the status message too — both sinks, not just one", async () => {
    // recordException and setStatus are separate calls carrying the same text.
    // Redacting only one is the failure this asserts against.
    const { withSpan } = await loadWithTracer();
    await expect(
      withSpan("op", {}, () => {
        throw new Error("connect https://svc:s3cret@backend.local/api failed");
      }),
    ).rejects.toThrow();
    expect(rec.statuses).toHaveLength(1);
    expect(rec.statuses[0].code).toBe(2);
    expect(rec.statuses[0].message).not.toContain("s3cret");
  });

  it("leaves the THROWN error untouched — only what leaves the process is redacted", async () => {
    const { withSpan } = await loadWithTracer();
    const original = new Error("https://user:keepme@h/x");
    await expect(
      withSpan("op", {}, () => {
        throw original;
      }),
    ).rejects.toBe(original);
    // Same object identity, same message: a caller's own error handling must
    // not be degraded by the exporter's redaction.
    expect(original.message).toContain("keepme");
  });

  it("handles a non-Error throw without recording an exception", async () => {
    const { withSpan } = await loadWithTracer();
    await expect(
      withSpan("op", {}, () => {
        throw "a string";
      }),
    ).rejects.toBe("a string");
    expect(rec.exceptions).toHaveLength(0);
    expect(rec.statuses[0].message).toBe("a string");
  });

  it("ends the span even when the callback throws", async () => {
    const { withSpan } = await loadWithTracer();
    await expect(
      withSpan("op", {}, () => {
        throw new Error("x");
      }),
    ).rejects.toThrow();
    expect(ended.count).toBe(1);
  });

  it("exposes the active trace id once a tracer exists", async () => {
    const { getCurrentTraceId } = await loadWithTracer();
    expect(getCurrentTraceId()).toBe("abc123traceid");
  });
});

describe("initObservability / shutdownObservability", () => {
  it("logs and disables itself when the OTel packages fail to load", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
    vi.resetModules();
    vi.doMock("@opentelemetry/sdk-node", () => {
      throw new Error("module missing");
    });
    const m = await import("../src/observability.js");
    await m.initObservability();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /OTLP init failed/,
    );
    // Disabled, not half-initialised: withSpan must fall back to the no-tracer
    // path rather than throwing on every instrumented call.
    expect(await m.withSpan("op", {}, () => "ok")).toBe("ok");
    expect(m.getCurrentTraceId()).toBeUndefined();
  });

  it("shutdownObservability is a no-op when nothing was initialised", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.resetModules();
    const m = await import("../src/observability.js");
    await expect(m.shutdownObservability()).resolves.toBeUndefined();
  });

  it("swallows a shutdown error — no caller remains to receive it", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
    vi.resetModules();
    const { api } = fakeOtel(rec, ended);
    vi.doMock("@opentelemetry/api", () => api);
    vi.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: class {
        start() {}
        async shutdown() {
          throw new Error("exporter already closed");
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
    const m = await import("../src/observability.js");
    await m.initObservability();
    await expect(m.shutdownObservability()).resolves.toBeUndefined();
  });
});
