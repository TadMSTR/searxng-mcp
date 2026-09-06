#!/usr/bin/env node
// Standalone domain-db maintenance job. Run on a schedule (cron / PM2 cron
// restart) — NOT as an in-process timer: searxng-mcp runs as several concurrent
// per-agent stdio children, so an in-process interval would fire in all of them
// at once (duplicate gauges, racing snapshot writes). This job is the single
// authoritative writer.
//
// One bounded SCAN of the domain-db feeds two outputs from the same pass:
//   1. OTel gauges (searxng_domains_tracked / _failing / tier success ratio) —
//      opt-in via OTEL_EXPORTER_OTLP_ENDPOINT, force-flushed before exit so a
//      short-lived run still exports.
//   2. A durable dated JSON snapshot (+ retention pruning) so learned domain
//      knowledge survives a Valkey flush / TTL expiry.

import {
  DOMAIN_DB_SNAPSHOT_DIR,
  DOMAIN_DB_SNAPSHOT_RETENTION,
} from "../config.js";
import { pruneSnapshots, writeSnapshot } from "../domain-snapshot.js";
import {
  aggregateDomainStats,
  type DomainAggregate,
  enumerateDomains,
  type TierSlotName,
} from "../domain-stats.js";

export interface GaugeData {
  domains_tracked: number;
  domains_failing: number;
  // Only tiers with attempts (non-null ratio) are emitted, one point per tier.
  tier_success_ratio: Array<{ tier: TierSlotName; ratio: number }>;
}

/** Pure: derive gauge values from an aggregate. */
export function deriveGauges(agg: DomainAggregate): GaugeData {
  const tier_success_ratio: Array<{ tier: TierSlotName; ratio: number }> = [];
  for (const [tier, ta] of Object.entries(agg.tiers)) {
    if (ta.success_rate !== null) {
      tier_success_ratio.push({
        tier: tier as TierSlotName,
        ratio: ta.success_rate,
      });
    }
  }
  return {
    domains_tracked: agg.domains_tracked,
    domains_failing: agg.failing_count,
    tier_success_ratio,
  };
}

/**
 * Emit the gauges via a self-contained MeterProvider, force-flushing before
 * shutdown so a short-lived run exports. No-op (returns false) when
 * OTEL_EXPORTER_OTLP_ENDPOINT is unset. Best-effort — logs and returns false on
 * any OTel error rather than failing the snapshot half of the job.
 */
export async function emitGauges(data: GaugeData): Promise<boolean> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  // Attribute the metrics to searxng-mcp via the env-based resource detector.
  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = "searxng-mcp";
  }
  try {
    const [
      { OTLPMetricExporter },
      { MeterProvider, PeriodicExportingMetricReader },
    ] = await Promise.all([
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
    ]);

    const reader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("searxng-mcp-maintenance");

    meter.createGauge("searxng_domains_tracked").record(data.domains_tracked);
    meter.createGauge("searxng_domains_failing").record(data.domains_failing);
    const ratioGauge = meter.createGauge("searxng_domain_tier_success_ratio");
    for (const { tier, ratio } of data.tier_success_ratio) {
      ratioGauge.record(ratio, { tier });
    }

    await provider.forceFlush();
    await provider.shutdown();
    return true;
  } catch (err) {
    console.error(
      `[domain-db-maintenance] gauge export failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export interface MaintenanceResult {
  count: number;
  /** Empty when no snapshot was written — see `skipped`. */
  snapshotPath: string;
  pruned: number;
  gaugesEmitted: boolean;
  truncated: boolean;
  aggregate: DomainAggregate;
  /**
   * Set when the corpus could not be read, in which case NOTHING was written
   * or pruned. Reading zero records and writing that out is how a transient
   * Valkey outage would have destroyed the restore path (vikunja#688).
   */
  skipped?: string;
}

export interface MaintenanceOptions {
  snapshotDir?: string;
  retention?: number;
}

/** Run one maintenance pass: SCAN → gauges + snapshot + prune. */
export async function runMaintenance(
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const dir = opts.snapshotDir ?? DOMAIN_DB_SNAPSHOT_DIR;
  const retention = opts.retention ?? DOMAIN_DB_SNAPSHOT_RETENTION;

  const { records, truncated, unavailable } = await enumerateDomains();
  const aggregate = aggregateDomainStats(records, truncated);

  // A corpus we could not read is not an empty corpus, and the difference is
  // destructive here rather than merely misleading. writeSnapshot would make
  // an empty file the NEWEST snapshot — the one loadLatestSnapshot returns and
  // restore-domain-db restores from — and pruneSnapshots would then age out a
  // real one. At the default retention of 14, fourteen consecutive failed runs
  // leave nothing but empty snapshots, each indistinguishable from a genuine
  // backup of an empty database.
  //
  // So: no snapshot, no prune, no gauges. Gauges are skipped too because
  // `aggregate` here describes nothing, and a zero written to a time series is
  // read later as a measurement rather than as an absence.
  if (unavailable) {
    return {
      count: 0,
      snapshotPath: "",
      pruned: 0,
      gaugesEmitted: false,
      truncated,
      aggregate,
      skipped: unavailable,
    };
  }

  const gaugesEmitted = await emitGauges(deriveGauges(aggregate));
  const { path, count } = await writeSnapshot(dir, records);
  const pruned = await pruneSnapshots(dir, retention);

  return {
    count,
    snapshotPath: path,
    pruned: pruned.length,
    gaugesEmitted,
    truncated,
    aggregate,
  };
}

export async function main(): Promise<number> {
  try {
    const r = await runMaintenance();
    // Exit non-zero so a scheduler surfaces the run rather than recording a
    // success that wrote nothing. This is the CI-shaped face of the same
    // defect: a green step that delivered no work.
    if (r.skipped) {
      console.error(
        `[domain-db-maintenance] SKIPPED — ${r.skipped}. No snapshot written, nothing pruned, no gauges emitted. ` +
          `This is NOT a report that the database is empty.`,
      );
      return 1;
    }
    console.log(
      `[domain-db-maintenance] snapshot ${r.snapshotPath} (${r.count} records${r.truncated ? ", TRUNCATED" : ""}); ` +
        `pruned ${r.pruned}; gauges ${r.gaugesEmitted ? "emitted" : "skipped (no OTLP endpoint)"}; ` +
        `tracked=${r.aggregate.domains_tracked} failing=${r.aggregate.failing_count}`,
    );
    return 0;
  } catch (err) {
    console.error(
      `[domain-db-maintenance] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
