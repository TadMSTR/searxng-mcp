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

const counters: Record<string, Counter | undefined> = {};
const histograms: Record<string, Histogram | undefined> = {};

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

    const nodeSdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
      }),
    });
    nodeSdk.start();
    sdk = nodeSdk;

    tracer = otelApi.trace.getTracer("searxng-mcp", "3.5.0");
    meter = otelApi.metrics.getMeter("searxng-mcp", "3.5.0");

    counters.search = meter.createCounter("searxng_search_total");
    counters.fetch = meter.createCounter("searxng_fetch_total");
    counters.cache = meter.createCounter("searxng_cache_total");
    counters.errors = meter.createCounter("searxng_errors_total");
    histograms.search = meter.createHistogram(
      "searxng_search_duration_seconds",
      { unit: "s" },
    );
    histograms.fetch = meter.createHistogram("searxng_fetch_duration_seconds", {
      unit: "s",
    });
  } catch (err) {
    console.error(
      `[searxng-mcp] OTLP init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    tracer = null;
    meter = null;
    otelApi = null;
    sdk = null;
  }
}

export async function shutdownObservability(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort
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
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({ code: 2, message: (err as Error)?.message });
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
  name: keyof typeof counters,
  attrs?: Attributes,
  count = 1,
): void {
  counters[name]?.add(count, cleanAttrs(attrs));
}

export function recordHistogram(
  name: keyof typeof histograms,
  value: number,
  attrs?: Attributes,
): void {
  histograms[name]?.record(value, cleanAttrs(attrs));
}
