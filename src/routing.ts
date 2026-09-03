// Data-driven tier routing. Skips tiers that cannot or should not run for a
// domain — because the tier is not configured at all, by operator override
// (`tier_skip` in domains.json), or by observed success rate (Phase 4 stats).
// Falls back to the full cascade during cold start (<10 attempts).

import { tierConfigured } from "./config.js";
import {
  currentWindowStat,
  getDomainRecord,
  type TierName,
} from "./domain-db.js";
import { getOperatorTierSkips } from "./domains.js";
import { ALL_TIERS, type Tier } from "./tiers/index.js";
import type { TierSlot } from "./types.js";

const MIN_ATTEMPTS_FOR_DECISION = 10;
const LOW_SUCCESS_THRESHOLD = 0.3;

export type SkipReason =
  | "operator_override"
  | "low_success_rate"
  | "not_configured";

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

  // Seeded FIRST, and this ordering is the one precedence rule a reader will
  // not guess: `not_configured` is absolute. An operator override cannot
  // un-skip an unconfigured tier — there is nothing to call — so the later
  // passes must not be able to overwrite this entry. Both of them skip slots
  // already in the map, so seeding first is what makes it absolute.
  //
  // Routing an unconfigured tier through the skip machinery (rather than
  // letting it fail inside runTier) is also what keeps the domain database
  // honest: a skipped tier is never recorded as an attempt, so tier_stats_30d
  // stops accumulating misses that mean "not configured" rather than "tried
  // and failed" — the same stats that drive the low_success_rate pass below.
  for (const [slot, configured] of Object.entries(tierConfigured())) {
    if (!configured) decisions.set(slot as TierSlot, "not_configured");
  }

  // Operator overrides win over the stats pass.
  for (const tier of getOperatorTierSkips(url)) {
    if (decisions.has(tier)) continue;
    decisions.set(tier, "operator_override");
  }

  // Data-driven: skip tiers with success rate < 30% over >=10 attempts.
  const record = await getDomainRecord(url);
  if (record) {
    for (const slot of ["tier1", "tier2", "tier3"] as const) {
      if (decisions.has(slot)) continue;
      // Read through the window cutoff: a tier must not stay skipped on the
      // strength of failures from outside the window it claims to measure.
      const stat = currentWindowStat(record.tier_stats_30d[slot]);
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
