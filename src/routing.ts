// Data-driven tier routing. Skips tiers that are clearly bad fits for a
// domain — either by operator override (`tier_skip` in domains.json) or by
// observed success rate (Phase 4 stats). Falls back to the full cascade
// during cold start (<10 attempts).

import { getDomainRecord, type TierName } from "./domain-db.js";
import { getOperatorTierSkips } from "./domains.js";
import { ALL_TIERS, type Tier } from "./tiers/index.js";
import type { TierSlot } from "./types.js";

const MIN_ATTEMPTS_FOR_DECISION = 10;
const LOW_SUCCESS_THRESHOLD = 0.3;

export type SkipReason = "operator_override" | "low_success_rate";

export interface TierSkipDecision {
  tier: TierSlot;
  reason: SkipReason;
}

export const TIER_NAME: Record<TierSlot, TierName> = {
  tier1: "tier1_firecrawl",
  tier2: "tier2_crawl4ai",
  tier3: "tier3_rawfetch",
};

export async function computeTierSkips(
  url: string,
): Promise<TierSkipDecision[]> {
  const decisions = new Map<TierSlot, SkipReason>();

  // Operator overrides always win.
  for (const tier of getOperatorTierSkips(url)) {
    decisions.set(tier, "operator_override");
  }

  // Data-driven: skip tiers with success rate < 30% over >=10 attempts.
  const record = await getDomainRecord(url);
  if (record) {
    for (const slot of ["tier1", "tier2", "tier3"] as const) {
      if (decisions.has(slot)) continue;
      const stat = record.tier_stats_30d[slot];
      if (stat.attempts < MIN_ATTEMPTS_FOR_DECISION) continue;
      const successRate = stat.ok / stat.attempts;
      if (successRate < LOW_SUCCESS_THRESHOLD) {
        decisions.set(slot, "low_success_rate");
      }
    }
  }

  return Array.from(decisions, ([tier, reason]) => ({ tier, reason }));
}

/**
 * Returns the active tier list and skip decisions for a URL.
 *
 * `active` is the ordered set of tiers to attempt (skips already removed).
 * `skipped` carries the skip decisions for observability/logging callers.
 */
export async function getTiers(url: string): Promise<{
  active: Tier[];
  skipped: TierSkipDecision[];
}> {
  const skipped = await computeTierSkips(url);
  const skipSlots = new Set(skipped.map((d) => d.tier));
  const active = ALL_TIERS.filter((t) => !skipSlots.has(t.slot));
  return { active, skipped };
}
