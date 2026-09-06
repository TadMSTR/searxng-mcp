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

import { getValkey } from "../cache.js";
import {
  DOMAIN_DB_SNAPSHOT_DIR,
  DOMAIN_DB_SNAPSHOT_RETENTION,
} from "../config.js";
import { SCHEMA_VERSION } from "../domain-db.js";
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
  /** Stale-schema keys deleted this pass. */
  reaped: number;
}

export interface MaintenanceOptions {
  snapshotDir?: string;
  retention?: number;
  /** Skip the stale-schema reap. Used by tests and by a cautious first run. */
  reap?: boolean;
}

/** Run one maintenance pass: SCAN → gauges + snapshot + prune. */
export async function runMaintenance(
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const dir = opts.snapshotDir ?? DOMAIN_DB_SNAPSHOT_DIR;
  const retention = opts.retention ?? DOMAIN_DB_SNAPSHOT_RETENTION;

  const {
    records,
    truncated,
    unavailable,
    staleKeys: allStaleKeys,
  } = await enumerateDomains();
  const staleKeys = opts.reap === false ? [] : allStaleKeys;
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
      reaped: 0,
      skipped: unavailable,
    };
  }

  const gaugesEmitted = await emitGauges(deriveGauges(aggregate));
  const { path, count } = await writeSnapshot(dir, records);
  const pruned = await pruneSnapshots(dir, retention);

  // Reap superseded records. These are already unreachable — every read goes
  // through parseDomainRecord, which gates on schema_version — so this changes
  // no observable behaviour. It is done AFTER the snapshot, and stale records
  // are excluded from snapshots anyway (isStructurallyValidRecord rejects them
  // on restore too), so there is no path by which a reaped record was still
  // recoverable.
  //
  // Why it is worth doing at all: the scan is bounded by DEFAULT_MAX_KEYS
  // (5000). Measured 2026-09-06, the live corpus was 1,295 keys of which 1,196
  // (92.4%) were dead across four superseded generations, with schema 2 still
  // resident. A sixth and seventh generation on that trajectory crosses the
  // bound, at which point `truncated` goes true and the aggregate silently
  // starts describing a subset of the corpus while still being read as a
  // total. That is the same defect class as the rest of this build, arriving
  // by a slower route.
  const reaped = await reapStaleKeys(staleKeys);

  return {
    count,
    snapshotPath: path,
    pruned: pruned.length,
    gaugesEmitted,
    truncated,
    aggregate,
    reaped,
  };
}

/**
 * Delete stale-schema keys in bounded batches, re-checking each key
 * immediately before it is deleted.
 *
 * THE RE-CHECK IS NOT DEFENSIVE PADDING — it closes a real race. The key list
 * is built during the scan; the delete happens after the snapshot and prune,
 * hundreds of milliseconds later, in a process whose fetch path is writing
 * domain records the whole time. A domain that gets fetched in that window has
 * its record rewritten at the CURRENT schema under the same key. Deleting it
 * on the strength of the earlier read would destroy a live record.
 *
 * It also relocates the safety property to where it can be tested. Without it,
 * nothing about "never delete a live record" is enforced here at all: the
 * caller's `isStaleSchema` is unreachable for current-schema records, because
 * `parseDomainRecord` returns non-null and short-circuits first. That made the
 * protection an artefact of statement ordering — a mutation making
 * `isStaleSchema` return true for EVERY parseable record passed all 42 tests,
 * because it is never consulted for the records that matter. A reordering
 * would have removed the protection with nothing going red.
 *
 * A failure to delete is not fatal and not silent: the records were already
 * unreachable, so the pass is still a success, but a reaper that never manages
 * to delete anything must not report the same "0" as a corpus with nothing to
 * reap.
 */
async function reapStaleKeys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const client = await getValkey();
  if (!client) return 0;
  let deleted = 0;
  const BATCH = 200;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    try {
      // Re-read and keep only those STILL carrying a superseded schema.
      const raws = await client.mget(batch);
      const confirmed = batch.filter((_key, j) => {
        const raw = raws[j];
        if (!raw) return false; // already gone
        try {
          const v = (JSON.parse(raw) as { schema_version?: unknown })
            .schema_version;
          return typeof v === "number" && v !== SCHEMA_VERSION;
        } catch {
          // Unreadable now, whatever it was before. Not ours to delete.
          return false;
        }
      });
      if (confirmed.length !== batch.length) {
        console.error(
          `[domain-db-maintenance] ${batch.length - confirmed.length} key(s) were rewritten between scan and reap — not deleting them`,
        );
      }
      if (confirmed.length === 0) continue;
      deleted += Number(await client.del(...confirmed)) || 0;
    } catch (err) {
      console.error(
        `[domain-db-maintenance] stale-key reap failed after ${deleted} of ${keys.length}: ${
          err instanceof Error ? err.message : String(err)
        } — the records remain unreachable, so this is not data loss, but the reap did not complete`,
      );
      return deleted;
    }
  }
  return deleted;
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
        `pruned ${r.pruned}; reaped ${r.reaped} stale-schema keys; ` +
        `gauges ${r.gaugesEmitted ? "emitted" : "skipped (no OTLP endpoint)"}; ` +
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
