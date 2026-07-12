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
import { type DomainRecord, parseDomainRecord } from "./domain-db.js";

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

// Slots aggregated across the tier_stats_30d block. Mirrors the domain-db
// TIER_KEY value union (tier1-4 cascade + github fast path).
export type TierSlotName = "tier1" | "tier2" | "tier3" | "tier4" | "github";
const TIER_SLOTS: readonly TierSlotName[] = [
  "tier1",
  "tier2",
  "tier3",
  "tier4",
  "github",
];

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

export interface DomainAggregate {
  domains_tracked: number;
  // Domains seen in search results but never actually fetched (no tier
  // attempts) — candidates the cascade has never exercised.
  seen_never_fetched: number;
  tiers: Record<TierSlotName, TierAggregate>;
  // Domains with enough attempts to judge and a low success rate, worst
  // (most attempts) first, capped at TOP_FAILING_LIMIT.
  top_failing: FailingDomain[];
  // True when enumeration hit the key cap — the aggregate covers a subset.
  truncated: boolean;
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
 */
export async function enumerateDomains(
  opts: EnumerateOptions = {},
): Promise<EnumerateResult> {
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const records: DomainRecord[] = [];
  let truncated = false;
  try {
    const client = await getValkey();
    if (!client) return { records, truncated };

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

    if (keys.length === 0) return { records, truncated };

    // Bulk-read the collected keys; skip stale-schema / malformed entries.
    const raws = await client.mget(keys);
    for (const raw of raws) {
      const parsed = parseDomainRecord(raw);
      if (parsed) records.push(parsed);
    }
    return { records, truncated };
  } catch {
    // Best-effort — never throw onto the caller. Return whatever was collected.
    return { records, truncated };
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
): DomainAggregate {
  const tiers: Record<TierSlotName, TierAggregate> = {
    tier1: emptyTierAggregate(),
    tier2: emptyTierAggregate(),
    tier3: emptyTierAggregate(),
    tier4: emptyTierAggregate(),
    github: emptyTierAggregate(),
  };
  let seenNeverFetched = 0;
  const failing: FailingDomain[] = [];

  for (const record of records) {
    let domainAttempts = 0;
    let domainOk = 0;
    for (const slot of TIER_SLOTS) {
      // Defensive: a same-schema but malformed record could lack a slot. Skip
      // rather than throw — the enumeration contract is best-effort.
      const stat = record.tier_stats_30d?.[slot];
      if (!stat) continue;
      const agg = tiers[slot];
      agg.attempts += stat.attempts;
      agg.ok += stat.ok;
      agg.fail += stat.fail;
      domainAttempts += stat.attempts;
      domainOk += stat.ok;
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
    domains_tracked: records.length,
    seen_never_fetched: seenNeverFetched,
    tiers,
    top_failing: failing.slice(0, TOP_FAILING_LIMIT),
    truncated,
  };
}
