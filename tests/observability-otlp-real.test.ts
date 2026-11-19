// OpenTelemetry against the REAL SDK: no vi.doMock of any @opentelemetry/*
// module in this file. Keep it that way.
//
// Every other OTel test mocks the SDK, and initObservability() catches any init
// error and logs one "OTLP init failed" line. So an SDK upgrade that breaks a
// constructor option leaves those tests green and turns tracing off in
// production with nothing but a stderr line. sdk-node 0.300 removing
// `metricReader` is the case this was written for.
//
// Each test points the OTLP exporters at a local HTTP server and asserts the
// export actually arrived. Shutdown flushes both the batch span processor and
// the periodic metric reader, so no test-only interval option is needed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Received = { method: string; url: string; body: Buffer };

let server: Server;
let received: Received[];
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("OTEL_SERVICE_NAME", "searxng-mcp-otlp-test");
  // With no metric reader configured, sdk-node builds an OTLP one from the
  // environment (OTEL_METRICS_EXPORTER defaults to otlp). That fallback would
  // export the counter even if our explicit reader were silently dropped, which
  // is exactly the `metricReader` removal this test guards. Turning the env
  // fallback off means only the reader observability.ts passes can export.
  vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
  vi.stubEnv("OTEL_TRACES_EXPORTER", "none");
  // A per-signal endpoint takes precedence over OTEL_EXPORTER_OTLP_ENDPOINT,
  // so one set in the runner's environment would send the export elsewhere
  // and fail these tests for a reason they don't guard.
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(async () => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => r()));
});

function errorLines(): string[] {
  return errSpy.mock.calls.map((c) => c.map(String).join(" "));
}

function posts(path: string): Received[] {
  return received.filter((r) => r.method === "POST" && r.url === path);
}

describe("initObservability against the real SDK", () => {
  it("exports a span and a counter to the OTLP endpoint", async () => {
    const obs = await import("../src/observability.js");
    await obs.initObservability();

    expect(errorLines().filter((l) => l.includes("OTLP init failed"))).toEqual(
      [],
    );

    const out = await obs.withSpan(
      "otlp_real_sdk_probe",
      { probe: true },
      () => 42,
    );
    expect(out).toBe(42);
    obs.incCounter("search", { probe: "yes" });

    await obs.shutdownObservability();

    const traces = posts("/v1/traces");
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const traceBody = Buffer.concat(traces.map((t) => t.body));
    // Protobuf carries strings as raw UTF-8, so the names are findable bytes.
    expect(traceBody.includes("otlp_real_sdk_probe")).toBe(true);
    expect(traceBody.includes("searxng-mcp-otlp-test")).toBe(true);
    // Default resource detectors since sdk-node 0.300 (CHANGELOG 4.0.0).
    expect(traceBody.includes("service.instance.id")).toBe(true);

    const metrics = posts("/v1/metrics");
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(
      Buffer.concat(metrics.map((m) => m.body)).includes(
        "searxng_search_total",
      ),
    ).toBe(true);
  }, 10_000);
});

describe("emitGauges against the real SDK", () => {
  it("exports the gauges and returns true", async () => {
    const { emitGauges } = await import("../src/cli/domain-db-maintenance.js");
    const ok = await emitGauges({
      domains_tracked: 7,
      domains_failing: 1,
      tier_success_ratio: [{ tier: "tier3", ratio: 0.5 }],
    });

    expect(ok).toBe(true);
    expect(
      errorLines().filter((l) => l.includes("gauge export failed")),
    ).toEqual([]);
    const metrics = posts("/v1/metrics");
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const body = Buffer.concat(metrics.map((m) => m.body));
    expect(body.includes("searxng_domains_tracked")).toBe(true);
    expect(body.includes("searxng_domain_tier_success_ratio")).toBe(true);
  }, 10_000);
});
