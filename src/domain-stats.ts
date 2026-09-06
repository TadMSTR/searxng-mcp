// Bounded read + aggregation over the domain capability database (`domain:*`
// records in Valkey). Shared by the read-only `domain_stats` MCP tool and the
// standalone domain-db-maintenance job (gauges + snapshot).
//
// Never called from the search/fetch hot path: the SCAN is cursor-based,
// COUNT-limited, and hard-capped at DEFAULT_MAX_KEYS, and every entry point is
// operator- or cron-triggered. Reads are best-effort — a Valkey failure yields
// an empty result rather than throwing onto the caller, matching the domain-db
// write contract.

import { getValkey } from "./cache.js";
import {
  currentWindowStat,
  type DomainRecord,
  parseDomainRecord,
  SCHEMA_VERSION,
  TIER_SLOT_KEYS,
  type TierSlotKey,
  type TierStat,
  TIER_STATS_WINDOW_MS as WINDOW_MS,
} from "./domain-db.js";
import { describeTransportFailure } from "./transport-failure.js";

const DOMAIN_KEY_PATTERN = "domain:*";
// SCAN batch hint — how many keys Valkey returns per cursor step. Not a hard
// limit (SCAN may return more or fewer); the real bound is DEFAULT_MAX_KEYS.
const SCAN_COUNT = 200;
// Hard cap on keys pulled into memory in one enumeration. The real domain-db is
// low hundreds of records (~1KB each), so this covers it with wide headroom
// while bounding a runaway SCAN to well under a few MB. When the cap is hit the
// result carries `truncated: true` so callers never present a partial view as
// complete.
export const DEFAULT_MAX_KEYS = 5000;

// Slots aggregated across the tier_stats_30d block. Re-exported from domain-db
// rather than restated: this list used to be a second copy of the same closed
// set, and a slot added to the record but missed here would be silently
// excluded from every aggregate (an array literal is not exhaustiveness-checked
// against the union it is typed with).
export type TierSlotName = TierSlotKey;
const TIER_SLOTS = TIER_SLOT_KEYS;

/**
 * Display labels for the single-domain rendering, one per slot.
 *
 * A `Record<TierSlotKey, ...>` rather than a list of `tierLine(...)` calls,
 * which is what this block used to be: an array literal is not
 * exhaustiveness-checked, so a slot added to TIER_SLOT_KEYS but missed here
 * would record forever and never appear in single-domain output — the same
 * class of invisibility that let crawl_site's Firecrawl phase 404 unnoticed for
 * the life of the feature. Missing a key here is now a compile error.
 */
const TIER_SLOT_LABELS: Record<TierSlotKey, string> = {
  tier1: "tier1 (firecrawl)",
  tier2: "tier2 (crawl4ai) ",
  tier3: "tier3 (raw)      ",
  tier4: "tier4 (wayback)  ",
  github: "github (fastpath)",
  solver: "solver (byparr)  ",
  crawl: "crawl (firecrawl)",
};

// A domain is "failing" if it has enough attempts to judge and a low overall
// success rate. Tuned to surface the raw.githubusercontent.com-style cases
// (many attempts, near-zero successes) that the blind spot was hiding.
const FAILING_MIN_ATTEMPTS = 5;
const FAILING_MAX_SUCCESS_RATE = 0.5;
const TOP_FAILING_LIMIT = 10;

export interface EnumerateOptions {
  maxKeys?: number;
}

export interface EnumerateResult {
  records: DomainRecord[];
  truncated: boolean;
  /**
   * Set when the corpus could not be read. `records` is then not a corpus —
   * it is whatever had been collected before the failure, and callers must not
   * treat it as the database's contents.
   *
   * This field exists because its absence caused real damage (vikunja#688).
   * A failed scan returned `{records: [], truncated: false}`, byte-identical
   * to a healthy scan over an empty database, and `domain-db-maintenance`
   * wrote that as a snapshot — making an empty file the newest restore point.
   */
  unavailable?: string;
  /**
   * Keys whose stored record parsed cleanly but carries a schema_version other
   * than the current one. Already unreachable — `parseDomainRecord` gates every
   * read on the schema — so deleting them changes no observable behaviour.
   *
   * Records that would NOT parse are deliberately excluded: unreadable is a
   * different thing from stale, and deleting data we cannot read is a
   * different decision from deleting data we have superseded.
   */
  staleKeys: string[];
}

export interface TierAggregate {
  attempts: number;
  ok: number;
  fail: number;
  // Overall ok-rate across all domains for this slot, 0-1 rounded to 2dp; null
  // when the slot has no attempts (distinguishes "0% success" from "no data").
  success_rate: number | null;
}

export interface FailingDomain {
  domain: string;
  attempts: number;
  ok: number;
  success_rate: number;
}

/**
 * The measurement period an aggregate actually covers.
 *
 * Distinct from `TIER_STATS_WINDOW_MS`, which is a TTL ceiling — the age at
 * which counts are discarded — not a period anyone measured. The rendered
 * header said "30d window" unconditionally, so an aggregate built minutes after
 * a schema reset presented as thirty days of evidence (vikunja#686).
 */
export interface AggregateWindow {
  // Epoch ms of the oldest counting window contributing to this aggregate, or
  // null when nothing has been counted yet.
  oldest_sample_ms: number | null;
  // How long that window has actually been open. Null when there is no sample.
  elapsed_ms: number | null;
  // The TTL ceiling counts are discarded at. Present so a caller can tell how
  // far the real window is from the maximum without hardcoding it.
  ttl_ceiling_ms: number;
}

export interface DomainAggregate {
  // The record schema every contributing record is on. Every schema bump
  // deliberately discards prior records (see domain-db.ts) — surfacing the
  // version is what lets a reader recognise a post-reset aggregate without
  // going to the snapshot directory.
  schema_version: number;
  window: AggregateWindow;
  domains_tracked: number;
  // Domains seen in search results but never actually fetched (no tier
  // attempts) — candidates the cascade has never exercised.
  seen_never_fetched: number;
  tiers: Record<TierSlotName, TierAggregate>;
  // Total number of failing domains (enough attempts + low success rate),
  // uncapped — top_failing is a bounded sample of this set.
  failing_count: number;
  // Domains with enough attempts to judge and a low success rate, worst
  // (most attempts) first, capped at TOP_FAILING_LIMIT.
  top_failing: FailingDomain[];
  // True when enumeration hit the key cap — the aggregate covers a subset.
  truncated: boolean;
}

/**
 * Below this many attempts, render the count instead of a percentage.
 *
 * Five, because at n=4 a single outcome moves the rate by 25 points and at n=5
 * by 20 — so any percentage drawn from fewer than five samples implies a
 * precision the sample cannot support. "100% ok (1/1)" and "0% ok (0/1)" are the
 * same amount of evidence about a domain, and rendering them as percentages
 * invites a reader to treat them as opposite findings. `no data` was already
 * distinguished from a number; *barely any data* was not (vikunja#686).
 *
 * Deliberately not the same constant as MIN_ATTEMPTS_FOR_DECISION in routing.ts,
 * which is 10 and governs whether to *act* on a rate by skipping a tier. Acting
 * needs more evidence than displaying, and tying the two would mean a change to
 * one silently retuning the other.
 */
export const MIN_ATTEMPTS_FOR_RATE = 5;

/**
 * How a tier's success should be shown: a rate, a low-confidence count, or
 * nothing at all. Shared by the per-domain and aggregate renderings so the two
 * cannot disagree about what counts as enough evidence.
 */
function renderRate(ok: number, attempts: number): string {
  if (attempts === 0) return "no data";
  if (attempts < MIN_ATTEMPTS_FOR_RATE) {
    return `insufficient data (${ok}/${attempts})`;
  }
  return `${Math.round((ok / attempts) * 100)}% ok (${ok}/${attempts})`;
}

/** Compact human duration for an elapsed window — "14h", "3d", "45m". */
function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyTierAggregate(): TierAggregate {
  return { attempts: 0, ok: 0, fail: 0, success_rate: null };
}

/**
 * Enumerate current-schema domain records via a bounded, cursor-based SCAN.
 * Stops once `maxKeys` keys have been collected and flags `truncated`. Stale or
 * malformed records are silently dropped (parseDomainRecord gate).
 *
 * A failure to read the corpus sets `unavailable` rather than returning an
 * empty one. The two were previously the same value, which is how a Valkey
 * outage could present as "domains tracked: 0" — and, worse, get written out
 * as an empty snapshot (vikunja#688). Research hit the reporting half of this
 * while measuring for the very plan that fixes it: a `0` that was an auth
 * failure, not an empty database.
 */
/**
 * Did this record parse as JSON with a schema_version that is simply not the
 * current one? Distinguishes "superseded" from "corrupt": only the former is
 * data we deliberately replaced.
 *
 * THIS IS A FILTER, NOT THE SAFETY GUARD. It cannot be reached for a
 * current-schema record — `parseDomainRecord` returns non-null and
 * short-circuits above — so a mutation making it return true for every
 * parseable record changes nothing observable and passes the whole suite. Do
 * not read it as the thing preventing a live delete.
 *
 * What prevents that is `reapStaleKeys`, which re-reads every key immediately
 * before deleting it and drops any that no longer carries a superseded schema.
 * That check is reachable, is tested, and additionally closes the race where
 * the fetch path rewrites a record between the scan and the delete.
 */
function isStaleSchema(raw: string): boolean {
  try {
    const v = (JSON.parse(raw) as { schema_version?: unknown }).schema_version;
    return typeof v === "number" && v !== SCHEMA_VERSION;
  } catch {
    // Reviewed (vikunja#687 class sweep): unparseable is not stale. Returning
    // false here means a corrupt record is left alone rather than reaped.
    return false;
  }
}

export async function enumerateDomains(
  opts: EnumerateOptions = {},
): Promise<EnumerateResult> {
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const records: DomainRecord[] = [];
  const staleKeys: string[] = [];
  let truncated = false;
  try {
    const client = await getValkey();
    // Not configured is not the same as empty either: there is no corpus to
    // report on, so callers must not record a zero against it.
    if (!client)
      return {
        records,
        truncated,
        staleKeys,
        unavailable: "domain database not configured (no cache backend)",
      };

    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await client.scan(
        cursor,
        "MATCH",
        DOMAIN_KEY_PATTERN,
        "COUNT",
        SCAN_COUNT,
      );
      cursor = nextCursor;
      for (const key of batch) {
        if (keys.length >= maxKeys) {
          truncated = true;
          break;
        }
        keys.push(key);
      }
    } while (cursor !== "0" && !truncated);

    if (keys.length === 0) return { records, truncated, staleKeys };

    // Bulk-read the collected keys; skip stale-schema / malformed entries.
    //
    // Stale ones are now also collected by key so the maintenance job can reap
    // them (vikunja#688). Measured on the live corpus 2026-09-06: 1,295 keys,
    // of which 1,196 (92.4%) are stale across four superseded generations —
    // schema 2 (122), 4 (475), 5 (436) and 6 (163) — against 99 current. That
    // is dead weight inside a scan bounded by DEFAULT_MAX_KEYS (5000), and the
    // bound is the reason it matters: once the corpus crosses it, `truncated`
    // goes true and the aggregate silently starts describing a subset. A
    // truncated total reported as a total is the same class of defect as the
    // rest of this build.
    const raws = await client.mget(keys);
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      const parsed = parseDomainRecord(raw);
      if (parsed) {
        records.push(parsed);
        continue;
      }
      const key = keys[i];
      if (raw && key && isStaleSchema(raw)) staleKeys.push(key);
    }
    return { records, truncated, staleKeys };
  } catch (err) {
    // Still never throws onto the caller — the callers are a reporting tool and
    // a scheduled job, and neither is improved by an exception. What changed is
    // that the result now says it is not a corpus.
    return {
      records,
      truncated,
      // Whatever was collected before the failure is not a complete set, and
      // the caller is told not to act on it — but do not hand back a partial
      // delete list either.
      staleKeys: [],
      unavailable: describeTransportFailure(err, "domain database"),
    };
  }
}

/**
 * Aggregate a set of domain records into per-tier totals, tracked/seen counts,
 * and a top-failing list. Pure and synchronous — the caller owns enumeration,
 * so this is trivially testable and reused by both the tool and the job.
 */
export function aggregateDomainStats(
  records: DomainRecord[],
  truncated = false,
  now: number = Date.now(),
): DomainAggregate {
  const tiers = Object.fromEntries(
    TIER_SLOTS.map((slot) => [slot, emptyTierAggregate()]),
  ) as Record<TierSlotName, TierAggregate>;
  let seenNeverFetched = 0;
  const failing: FailingDomain[] = [];
  // Oldest counting window across every contributing stat. Only windows that
  // actually counted something are considered: a zeroed slot's window_start is
  // bookkeeping, not evidence, and letting it in would report a measurement
  // period longer than anything was measured over.
  let oldestSampleMs: number | null = null;

  for (const record of records) {
    let domainAttempts = 0;
    let domainOk = 0;
    for (const slot of TIER_SLOTS) {
      // Defensive: a same-schema but malformed record could lack a slot. Skip
      // rather than throw — the enumeration contract is best-effort.
      if (!record.tier_stats_30d?.[slot]) continue;
      // Out-of-window stats read as empty, so "top failing domains" reflects
      // the last 30 days rather than whatever a domain last recorded before it
      // stopped being fetched.
      const stat = currentWindowStat(record.tier_stats_30d[slot], now);
      const agg = tiers[slot];
      agg.attempts += stat.attempts;
      agg.ok += stat.ok;
      agg.fail += stat.fail;
      domainAttempts += stat.attempts;
      domainOk += stat.ok;
      if (
        stat.attempts > 0 &&
        (oldestSampleMs === null || stat.window_start_ms < oldestSampleMs)
      ) {
        oldestSampleMs = stat.window_start_ms;
      }
    }

    if (domainAttempts === 0) {
      if (record.capabilities?.seen_in_search) seenNeverFetched += 1;
    } else if (
      domainAttempts >= FAILING_MIN_ATTEMPTS &&
      domainOk / domainAttempts < FAILING_MAX_SUCCESS_RATE
    ) {
      failing.push({
        domain: record.domain,
        attempts: domainAttempts,
        ok: domainOk,
        success_rate: round2(domainOk / domainAttempts),
      });
    }
  }

  for (const slot of TIER_SLOTS) {
    const agg = tiers[slot];
    agg.success_rate = agg.attempts > 0 ? round2(agg.ok / agg.attempts) : null;
  }

  failing.sort((a, b) => b.attempts - a.attempts);

  return {
    schema_version: SCHEMA_VERSION,
    window: {
      oldest_sample_ms: oldestSampleMs,
      elapsed_ms: oldestSampleMs === null ? null : now - oldestSampleMs,
      ttl_ceiling_ms: WINDOW_MS,
    },
    domains_tracked: records.length,
    seen_never_fetched: seenNeverFetched,
    tiers,
    failing_count: failing.length,
    top_failing: failing.slice(0, TOP_FAILING_LIMIT),
    truncated,
  };
}

// ── Single-domain summary (structured output for the domain_stats tool) ──────

export interface SingleDomainSummary {
  domain: string;
  first_seen: string;
  last_fetch: string;
  preferred_strategy: string | null;
  tiers: Record<TierSlotName, TierAggregate>;
  capabilities: {
    llms_full_txt: boolean;
    robots_allows_us: boolean | null;
    metadata_fetch_rate: number | null;
    seen_in_search: number;
  };
}

function tierAggregateOf(raw: TierStat, now: number): TierAggregate {
  const stat = currentWindowStat(raw, now);
  return {
    attempts: stat.attempts,
    ok: stat.ok,
    fail: stat.fail,
    success_rate: stat.attempts > 0 ? round2(stat.ok / stat.attempts) : null,
  };
}

/**
 * Reduce a full DomainRecord to the compact, agent-consumable shape returned as
 * `structuredContent` — per-tier success rates plus the capability flags an
 * agent would threshold on, without the internal window bookkeeping.
 */
export function summarizeDomainRecord(
  record: DomainRecord,
  now: number = Date.now(),
): SingleDomainSummary {
  const t = record.tier_stats_30d;
  const meta = record.capabilities.metadata_fetch;
  return {
    domain: record.domain,
    first_seen: record.first_seen,
    last_fetch: record.last_fetch,
    preferred_strategy: record.preferred_strategy ?? null,
    tiers: Object.fromEntries(
      TIER_SLOTS.map((slot) => [slot, tierAggregateOf(t[slot], now)]),
    ) as Record<TierSlotName, TierAggregate>,
    capabilities: {
      llms_full_txt: record.capabilities.llms_full_txt?.present ?? false,
      robots_allows_us: record.capabilities.robots_txt
        ? record.capabilities.robots_txt.allows_us
        : null,
      metadata_fetch_rate:
        meta && meta.attempts > 0 ? round2(meta.ok / meta.attempts) : null,
      seen_in_search: record.capabilities.seen_in_search?.count ?? 0,
    },
  };
}

// ── Human-readable formatters (shared by the dump-domain CLI and the tool) ───

function tierLine(label: string, raw: TierStat, now: number): string {
  const stat = currentWindowStat(raw, now);
  const expired = stat !== raw;
  const successRate = renderRate(stat.ok, stat.attempts);
  const daysLeft = Math.max(
    0,
    Math.round((WINDOW_MS - (now - stat.window_start_ms)) / 86400000),
  );
  // Say so explicitly when counts were dropped. "no data" alone would read as
  // "never attempted", which is a materially different fact for an operator
  // deciding whether a domain is broken or simply idle.
  const window = expired
    ? "window expired — counts reset on next fetch"
    : `window resets in ~${daysLeft}d`;
  const failNote =
    !expired && stat.last_fail_reason
      ? ` | last fail: ${stat.last_fail_reason}`
      : "";
  return `  ${label}: ${successRate} | ${window}${failNote}`;
}

/**
 * Human-readable tier-stats + capabilities block for one domain. Shared by the
 * dump-domain CLI and the domain_stats tool's text `content`.
 */
export function formatDomainRecord(
  record: DomainRecord,
  now: number = Date.now(),
): string {
  const t = record.tier_stats_30d;
  const lines = [
    `domain: ${record.domain} (first seen ${record.first_seen}, last fetch ${record.last_fetch})`,
    `preferred strategy: ${record.preferred_strategy ?? "none"}`,
    "",
    "--- tier stats (30d window) ---",
    ...TIER_SLOTS.map((slot) => tierLine(TIER_SLOT_LABELS[slot], t[slot], now)),
  ];

  const meta = record.capabilities.metadata_fetch;
  lines.push(
    meta
      ? `  metadata_fetch   : ${Math.round((meta.ok / meta.attempts) * 100)}% ok (${meta.ok}/${meta.attempts}) | last checked: ${meta.last_checked}`
      : "  metadata_fetch   : no data",
  );

  const seen = record.capabilities.seen_in_search;
  lines.push(
    seen
      ? `  seen_in_search   : ${seen.count}x | last seen: ${seen.last_seen_at}`
      : "  seen_in_search   : never seen in search results",
  );

  return lines.join("\n");
}

/**
 * Render the window an aggregate actually covers, with the TTL ceiling named
 * separately so the two are never confused for each other again.
 */
function describeWindow(window: AggregateWindow): string {
  const ceiling = humanDuration(window.ttl_ceiling_ms);
  if (window.oldest_sample_ms === null || window.elapsed_ms === null) {
    return `no samples yet, ${ceiling} ceiling`;
  }
  const since = new Date(window.oldest_sample_ms).toISOString();
  return `window ${humanDuration(window.elapsed_ms)} since ${since}, ${ceiling} ceiling`;
}

/**
 * Human-readable rendering of an aggregate across the whole domain-db. Shared by
 * the domain_stats tool's text `content` and available to the maintenance job.
 */
export function formatDomainAggregate(agg: DomainAggregate): string {
  const lines = [
    `domains tracked: ${agg.domains_tracked}${agg.truncated ? " (truncated — scan cap hit)" : ""}`,
    `seen in search but never fetched: ${agg.seen_never_fetched}`,
    "",
    // The measured period, not the TTL ceiling. This header read "30d window"
    // unconditionally, so an aggregate taken an hour after a schema reset
    // presented as a month of evidence — which is how the 6->7 reset was read
    // as a bug twice (vikunja#686). The schema version is here for the same
    // reason: it is the thing that explains a suddenly-empty database.
    `--- per-tier success (all domains, ${describeWindow(agg.window)}, schema ${agg.schema_version}) ---`,
  ];
  for (const [slot, ta] of Object.entries(agg.tiers)) {
    lines.push(`  ${slot.padEnd(7)}: ${renderRate(ta.ok, ta.attempts)}`);
  }

  const more =
    agg.failing_count > agg.top_failing.length
      ? ` (showing top ${agg.top_failing.length} of ${agg.failing_count})`
      : "";
  lines.push("", `--- top failing domains (worst first)${more} ---`);
  if (agg.top_failing.length === 0) {
    lines.push("  none");
  } else {
    for (const f of agg.top_failing) {
      lines.push(
        `  ${f.domain}: ${Math.round(f.success_rate * 100)}% ok (${f.ok}/${f.attempts})`,
      );
    }
  }

  return lines.join("\n");
}
