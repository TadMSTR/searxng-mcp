// OpenTelemetry tracing + metrics. Everything is opt-in: with no
// OTEL_EXPORTER_OTLP_ENDPOINT set, this module no-ops and never requires the
// OTel packages at runtime (type-only imports below are erased by tsc).
import type {
  Counter,
  Histogram,
  Meter,
  Span,
  Tracer,
} from "@opentelemetry/api";
import { redactUrlCredentialsInText } from "./log.js";
import { VERSION } from "./version.js";

/** The span a `withSpan` callback receives, for setting attributes on it. */
export type ToolSpan = Span;

type SpanStatusCode = 1 | 2; // 1 = OK, 2 = ERROR
type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue | undefined>;

interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): Tracer;
    getActiveSpan(): Span | undefined;
  };
  metrics: {
    getMeter(name: string, version?: string): Meter;
  };
  SpanStatusCode: { OK: SpanStatusCode; ERROR: SpanStatusCode };
}

let tracer: Tracer | null = null;
let meter: Meter | null = null;
let otelApi: OtelApi | null = null;
let sdk: { shutdown: () => Promise<void> } | null = null;

// Every instrument this module exports, by the short name call sites use.
//
// The names are a closed set on purpose. These maps were `Record<string, …>`
// until 4.1.0, so `incCounter("crawl")` type-checked against an instrument that
// was never created, and `counters[name]?.add` quietly did nothing: crawl
// metrics were never exported, and nothing failed. With the keys typed from
// these constants, an uncreated name is a compile error, and
// tests/observability-otlp-real.test.ts checks that every name here reaches the
// exporter.
//
// LABEL RULE: no URL, domain, query text or error message in any metric label.
// Each distinct label value is a new time series, and those are unbounded (and
// can carry what a caller typed). They go on spans only. Labels are fixed
// vocabularies: tool and tier names, outcomes, error class names.
export const COUNTER_NAMES = {
  search: "searxng_search_total",
  fetch: "searxng_fetch_total",
  cache: "searxng_cache_total",
  errors: "searxng_errors_total",
  crawl: "searxng_crawl_total",
  degrade: "searxng_degrade_total",
} as const;

/** Reranker relevance is 0..1, so the score histogram buckets are tenths. */
export const RERANK_SCORE_BUCKETS = [
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
];

export const HISTOGRAM_DEFS = {
  search: { name: "searxng_search_duration_seconds", unit: "s" },
  fetch: { name: "searxng_fetch_duration_seconds", unit: "s" },
  crawl: { name: "searxng_crawl_duration_seconds", unit: "s" },
  rerank_top_score: {
    name: "searxng_rerank_top_score",
    buckets: RERANK_SCORE_BUCKETS,
  },
} as const satisfies Record<
  string,
  { name: string; unit?: string; buckets?: readonly number[] }
>;

export type CounterName = keyof typeof COUNTER_NAMES;
export type HistogramName = keyof typeof HISTOGRAM_DEFS;

const counters: Partial<Record<CounterName, Counter>> = {};
const histograms: Partial<Record<HistogramName, Histogram>> = {};

export async function initObservability(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  try {
    const [
      api,
      { NodeSDK },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
    ] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
    ]);

    otelApi = api as unknown as OtelApi;

    const serviceName = process.env.OTEL_SERVICE_NAME ?? "searxng-mcp";

    // Keep this an inline object literal. sdk-node 0.300 removed
    // `metricReader` (singular), and the excess-property check on a literal is
    // what turned that into a compile error. Built in a variable first, a
    // removed key would compile and be ignored at runtime, and init would
    // "succeed" without metrics. tests/observability-otlp-real.test.ts runs
    // this against the real SDK for the same reason.
    const nodeSdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter(),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 60_000,
        }),
      ],
    });
    nodeSdk.start();
    sdk = nodeSdk;

    tracer = otelApi.trace.getTracer("searxng-mcp", VERSION);
    meter = otelApi.metrics.getMeter("searxng-mcp", VERSION);

    for (const key of Object.keys(COUNTER_NAMES) as CounterName[]) {
      counters[key] = meter.createCounter(COUNTER_NAMES[key]);
    }
    for (const key of Object.keys(HISTOGRAM_DEFS) as HistogramName[]) {
      const def: { name: string; unit?: string; buckets?: readonly number[] } =
        HISTOGRAM_DEFS[key];
      histograms[key] = meter.createHistogram(def.name, {
        ...(def.unit !== undefined && { unit: def.unit }),
        ...(def.buckets !== undefined && {
          advice: { explicitBucketBoundaries: [...def.buckets] },
        }),
      });
    }
  } catch (err) {
    console.error(
      `[searxng-mcp] OTLP init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    tracer = null;
    meter = null;
    otelApi = null;
    sdk = null;
    for (const key of Object.keys(counters) as CounterName[]) {
      delete counters[key];
    }
    for (const key of Object.keys(histograms) as HistogramName[]) {
      delete histograms[key];
    }
  }
}

export async function shutdownObservability(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Reviewed (vikunja#687 class sweep): shutdown path, same reasoning as
    // shutdownEvents — no caller remains to receive the error.
  }
}

function cleanAttrs(attrs?: Attributes): Record<string, AttributeValue> {
  if (!attrs) return {};
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span | undefined) => Promise<T> | T,
): Promise<T> {
  if (!tracer) return await fn(undefined);
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(cleanAttrs(attrs));
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      // Scrubbed before it reaches the exporter. An error message can carry a
      // credentialed URL (Node's fetch embeds one in its own TypeError), and a
      // span is exported off-host over OTLP — so this is a sink like any other.
      // The thrown error is left untouched; only what leaves the process is
      // redacted.
      if (err instanceof Error) {
        const safe = new Error(redactUrlCredentialsInText(err.message));
        safe.name = err.name;
        span.recordException(safe);
      }
      span.setStatus({
        code: 2,
        message: redactUrlCredentialsInText(
          err instanceof Error ? err.message : String(err),
        ),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function getCurrentTraceId(): string | undefined {
  if (!otelApi) return undefined;
  return otelApi.trace.getActiveSpan()?.spanContext().traceId;
}

export function incCounter(
  name: CounterName,
  attrs?: Attributes,
  count = 1,
): void {
  counters[name]?.add(count, cleanAttrs(attrs));
}

export function recordHistogram(
  name: HistogramName,
  value: number,
  attrs?: Attributes,
): void {
  histograms[name]?.record(value, cleanAttrs(attrs));
}

