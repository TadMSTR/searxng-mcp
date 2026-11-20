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
  // @opentelemetry/api keeps its global providers on globalThis, which
  // vi.resetModules does not reset. Without this, a second test's
  // getMeter()/getTracer() resolves to the first test's shut-down SDK and
  // exports nothing. (Production initialises once per process.)
  const api = await import("@opentelemetry/api");
  api.metrics.disable();
  api.trace.disable();
  api.propagation.disable();
  api.context.disable();
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
    // The HTTP exporters post OTLP/JSON, so the names are findable bytes.
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

describe("every instrument observability.ts creates is exported", () => {
  // incCounter("crawl") compiled and exported nothing for several releases:
  // the instrument maps were Record<string, …>, and crawl was never created.
  // The expected list comes from the same constants the module creates from,
  // so a new instrument is covered here without anyone remembering to add it.
  it("one recording per instrument reaches /v1/metrics under its name", async () => {
    const obs = await import("../src/observability.js");
    await obs.initObservability();

    const counterKeys = Object.keys(
      obs.COUNTER_NAMES,
    ) as (keyof typeof obs.COUNTER_NAMES)[];
    const histogramKeys = Object.keys(
      obs.HISTOGRAM_DEFS,
    ) as (keyof typeof obs.HISTOGRAM_DEFS)[];
    for (const k of counterKeys) obs.incCounter(k, { probe: "yes" });
    for (const k of histogramKeys) obs.recordHistogram(k, 0.25);

    await obs.shutdownObservability();

    const body = Buffer.concat(posts("/v1/metrics").map((m) => m.body));
    const expected = [
      ...counterKeys.map((k) => obs.COUNTER_NAMES[k]),
      ...histogramKeys.map((k) => obs.HISTOGRAM_DEFS[k].name),
    ];
    // The 4.1.0 additions, named so a refactor that drops one from the
    // constants can't pass by shrinking the expected list too.
    expect(expected).toEqual(
      expect.arrayContaining([
        "searxng_crawl_total",
        "searxng_crawl_duration_seconds",
        "searxng_degrade_total",
        "searxng_rerank_top_score",
        "searxng_errors_total",
      ]),
    );
    const missing = expected.filter((name) => !body.includes(name));
    expect(missing).toEqual([]);
  }, 10_000);

  it("the rerank score histogram uses the 0..1 tenths buckets", async () => {
    const obs = await import("../src/observability.js");
    await obs.initObservability();
    obs.recordHistogram("rerank_top_score", 0.42);
    await obs.shutdownObservability();

    // The HTTP exporter posts OTLP/JSON. Find the histogram's data point and
    // read its bounds; the SDK default buckets (0, 5, 10, 25, …) would fail.
    type Metric = {
      name: string;
      histogram?: { dataPoints: { explicitBounds: number[] }[] };
    };
    const metricsOut: Metric[] = posts("/v1/metrics").flatMap((m) =>
      (
        JSON.parse(m.body.toString("utf8")) as {
          resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
        }
      ).resourceMetrics.flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) => sm.metrics),
      ),
    );
    const score = metricsOut.find((m) => m.name === "searxng_rerank_top_score");
    expect(score?.histogram?.dataPoints[0]?.explicitBounds).toEqual(
      obs.RERANK_SCORE_BUCKETS,
    );
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

describe("W3C traceparent from an authenticated HTTP caller", () => {
  const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
  const PARENT_ID = "00f067aa0ba902b7";
  const TOKEN = "t".repeat(64);
  let mcp: Server | undefined;

  afterEach(async () => {
    const s = mcp;
    mcp = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  // Through the real listener and the real MCP SDK transport into a tool
  // handler: proves the context survives StreamableHTTPServerTransport's
  // dispatch, which a unit test of withRemoteParent alone could not.
  async function callProbe(headers: Record<string, string>) {
    vi.stubEnv("SEARXNG_MCP_AUTH_TOKEN", TOKEN);
    const obs = await import("../src/observability.js");
    await obs.initObservability();
    const { createHttpRequestListener } = await import(
      "../src/http-transport.js"
    );
    const { McpServer } = await import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    );
    const seen: (string | undefined)[] = [];
    mcp = createServer(
      createHttpRequestListener(() => {
        const s = new McpServer({ name: "t", version: "0" });
        s.registerTool("probe", { description: "p" }, async () =>
          obs.withSpan("tool.probe", {}, () => {
            seen.push(obs.getCurrentTraceId());
            return { content: [{ type: "text" as const, text: "ok" }] };
          }),
        );
        return s;
      }),
    );
    await new Promise<void>((r) => mcp?.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    const base = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    };
    const init = await fetch(url, {
      method: "POST",
      headers: base,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "c", version: "0" },
        },
      }),
    });
    await init.text();
    const sid = init.headers.get("mcp-session-id") ?? "";
    const withSid = { ...base, "mcp-session-id": sid };
    await (
      await fetch(url, {
        method: "POST",
        headers: withSid,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      })
    ).text();
    const call = await fetch(url, {
      method: "POST",
      headers: { ...withSid, ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "probe", arguments: {} },
      }),
    });
    const text = await call.text();
    await obs.shutdownObservability();
    return { seen, text, status: call.status };
  }

  it("the tool span joins the caller's trace", async () => {
    const r = await callProbe({
      traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("ok");
    expect(r.seen).toEqual([TRACE_ID]);
    // The exported span names the caller's span as its parent.
    const body = Buffer.concat(posts("/v1/traces").map((t) => t.body));
    expect(body.includes(TRACE_ID)).toBe(true);
  }, 15_000);

  it.each([
    ["garbage", "not-a-traceparent"],
    ["all-zero trace id", `00-${"0".repeat(32)}-${PARENT_ID}-01`],
  ])(
    "a %s header starts a new root trace and fails nothing",
    async (_n, tp) => {
      const r = await callProbe({ traceparent: tp });
      expect(r.status).toBe(200);
      expect(r.text).toContain("ok");
      expect(r.seen).toHaveLength(1);
      expect(r.seen[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(r.seen[0]).not.toBe(TRACE_ID);
      expect(r.seen[0]).not.toBe("0".repeat(32));
    },
    15_000,
  );

  it("no header: a new root trace (the control)", async () => {
    const r = await callProbe({});
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).not.toBe(TRACE_ID);
  }, 15_000);
});

describe("withRemoteParent", () => {
  it("with observability off, runs fn and reads nothing", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const obs = await import("../src/observability.js");
    await obs.initObservability();
    const out = obs.withRemoteParent(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      () => obs.getCurrentTraceId() ?? "none",
    );
    expect(out).toBe("none");
  });

  it("takes the first value of a repeated header and ignores baggage", async () => {
    const obs = await import("../src/observability.js");
    await obs.initObservability();
    const api = await import("@opentelemetry/api");
    const out = obs.withRemoteParent(
      {
        traceparent: [
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "00-11111111111111111111111111111111-00f067aa0ba902b7-01",
        ],
        baggage: "k=v",
      },
      () => ({
        trace: api.trace.getSpanContext(api.context.active())?.traceId,
        baggage: api.propagation.getBaggage(api.context.active()),
      }),
    );
    await obs.shutdownObservability();
    expect(out.trace).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(out.baggage).toBeUndefined();
  });
});
