// The operator-facing half of the maintenance CLIs: main()'s exit codes and the
// messages that go with them, plus emitGauges' OTLP path.
//
// These matter more than their size suggests. Both CLIs run from a scheduler,
// and the exit code is the ONLY thing the scheduler sees — a run that wrote no
// snapshot and pruned nothing must not exit 0, or the failure is recorded as a
// success and surfaces months later as a missing backup. The existing tests
// cover runRestore/runMaintenance; nothing covered the layer that turns their
// results into an exit code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/domain-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/domain-snapshot.js")>();
  return { ...actual, loadLatestSnapshot: vi.fn(), applyRestore: vi.fn() };
});
vi.mock("../../src/cache.js", () => ({
  getValkey: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
  cacheClear: vi.fn(),
  cachePing: vi.fn(),
}));

import { getValkey } from "../../src/cache.js";
import { main as restoreMain } from "../../src/cli/restore-domain-db.js";
import { applyRestore, loadLatestSnapshot } from "../../src/domain-snapshot.js";

const loadLatestSnapshotMock = vi.mocked(loadLatestSnapshot);
const applyRestoreMock = vi.mocked(applyRestore);
const getValkeyMock = vi.mocked(getValkey);

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

const msgs = (s: ReturnType<typeof vi.spyOn>) =>
  s.mock.calls.map((c) => String(c[0])).join("\n");

describe("restore-domain-db main() — exit codes", () => {
  it("exits 1 and names the directory when there is no snapshot", async () => {
    loadLatestSnapshotMock.mockResolvedValue(null);
    expect(await restoreMain()).toBe(1);
    expect(msgs(errSpy)).toMatch(/no snapshot found in/);
    // Nothing was attempted, so nothing may be reported on stdout as done.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("exits 1 when Valkey is unavailable — a snapshot you cannot restore is not a success", async () => {
    loadLatestSnapshotMock.mockResolvedValue({
      created: "2026-09-07T00:00:00Z",
      // biome-ignore lint/suspicious/noExplicitAny: minimal shape; runRestore only reads .length here
      records: [{}, {}] as any,
    });
    getValkeyMock.mockResolvedValue(null);
    expect(await restoreMain()).toBe(1);
    expect(msgs(errSpy)).toMatch(/Valkey unavailable/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("exits 1 on a partial restore and says it is NOT a completed restore", async () => {
    // The dangerous case: some records landed. A message that only reported the
    // successes would read as a completed run.
    loadLatestSnapshotMock.mockResolvedValue({
      created: "2026-09-07T00:00:00Z",
      // biome-ignore lint/suspicious/noExplicitAny: minimal shape
      records: [{}, {}, {}, {}, {}] as any,
    });
    // biome-ignore lint/suspicious/noExplicitAny: RestoreClient shape is irrelevant to main()
    getValkeyMock.mockResolvedValue({} as any);
    applyRestoreMock.mockResolvedValue({
      total: 5,
      restored: 2,
      skipped: 1,
      failed: "connection reset",
    });
    expect(await restoreMain()).toBe(1);
    const m = msgs(errSpy);
    expect(m).toMatch(/ABANDONED after 2 of 5/);
    expect(m).toMatch(/NOT a completed restore/);
    // 5 total - 2 restored - 1 skipped = 2 never attempted.
    expect(m).toMatch(/remaining 2 records were not attempted/);
  });

  it("exits 0 and reports the counts on a clean restore", async () => {
    loadLatestSnapshotMock.mockResolvedValue({
      created: "2026-09-07T00:00:00Z",
      // biome-ignore lint/suspicious/noExplicitAny: minimal shape
      records: [{}, {}, {}] as any,
    });
    // biome-ignore lint/suspicious/noExplicitAny: RestoreClient shape is irrelevant to main()
    getValkeyMock.mockResolvedValue({} as any);
    applyRestoreMock.mockResolvedValue({ total: 3, restored: 2, skipped: 1 });
    expect(await restoreMain()).toBe(0);
    expect(msgs(logSpy)).toMatch(/restored 2, skipped 1 of 3/);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("domain-db-maintenance emitGauges", () => {
  const DATA = {
    domains_tracked: 42,
    domains_failing: 3,
    tier_success_ratio: [
      { tier: "tier1", ratio: 0.9 },
      { tier: "tier3", ratio: 0.5 },
    ],
  };

  it("returns false without touching OTel when no endpoint is configured", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const { emitGauges } = await import(
      "../../src/cli/domain-db-maintenance.js"
    );
    expect(await emitGauges(DATA)).toBe(false);
  });

  it("records every gauge and flushes before shutdown when an endpoint is set", async () => {
    // The ORDER of forceFlush before shutdown is the assertion that matters:
    // shutting down first discards exactly the metrics this job exists to
    // write, and the function would still return true.
    const order: string[] = [];
    const recorded: Array<[string, number, unknown]> = [];
    const gaugeFor = (name: string) => ({
      record: (v: number, attrs?: unknown) => recorded.push([name, v, attrs]),
    });

    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
    vi.resetModules();
    vi.doMock("@opentelemetry/exporter-metrics-otlp-http", () => ({
      OTLPMetricExporter: class {},
    }));
    vi.doMock("@opentelemetry/sdk-metrics", () => ({
      PeriodicExportingMetricReader: class {},
      MeterProvider: class {
        getMeter() {
          return { createGauge: (n: string) => gaugeFor(n) };
        }
        async forceFlush() {
          order.push("forceFlush");
        }
        async shutdown() {
          order.push("shutdown");
        }
      },
    }));

    const { emitGauges } = await import(
      "../../src/cli/domain-db-maintenance.js"
    );
    expect(await emitGauges(DATA)).toBe(true);
    expect(order).toEqual(["forceFlush", "shutdown"]);
    expect(recorded).toEqual([
      ["searxng_domains_tracked", 42, undefined],
      ["searxng_domains_failing", 3, undefined],
      ["searxng_domain_tier_success_ratio", 0.9, { tier: "tier1" }],
      ["searxng_domain_tier_success_ratio", 0.5, { tier: "tier3" }],
    ]);
    vi.doUnmock("@opentelemetry/exporter-metrics-otlp-http");
    vi.doUnmock("@opentelemetry/sdk-metrics");
  });

  it("sets OTEL_SERVICE_NAME only when it is not already set", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
    vi.stubEnv("OTEL_SERVICE_NAME", "");
    vi.resetModules();
    vi.doMock("@opentelemetry/exporter-metrics-otlp-http", () => ({
      OTLPMetricExporter: class {},
    }));
    vi.doMock("@opentelemetry/sdk-metrics", () => ({
      PeriodicExportingMetricReader: class {},
      MeterProvider: class {
        getMeter() {
          return { createGauge: () => ({ record: () => {} }) };
        }
        async forceFlush() {}
        async shutdown() {}
      },
    }));
    const { emitGauges } = await import(
      "../../src/cli/domain-db-maintenance.js"
    );
    await emitGauges(DATA);
    expect(process.env.OTEL_SERVICE_NAME).toBe("searxng-mcp");
    vi.doUnmock("@opentelemetry/exporter-metrics-otlp-http");
    vi.doUnmock("@opentelemetry/sdk-metrics");
  });

  it("returns false and logs rather than failing the snapshot half of the job", async () => {
    // Gauge export is best-effort by design: the snapshot is the job that
    // matters, and an OTLP outage must not cost a backup.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318");
    vi.resetModules();
    vi.doMock("@opentelemetry/sdk-metrics", () => {
      throw new Error("module load failed");
    });
    const { emitGauges } = await import(
      "../../src/cli/domain-db-maintenance.js"
    );
    expect(await emitGauges(DATA)).toBe(false);
    expect(msgs(errSpy)).toMatch(/gauge export failed/);
    vi.doUnmock("@opentelemetry/sdk-metrics");
  });
});
