import type { TierName } from "../domain-db.js";
import type { FetchTuning, TierResult } from "../fetch-utils.js";
import type { TierSlot } from "../types.js";

/**
 * A single fetch tier in the cascade.
 *
 * `slot` maps to the TierSlot used for skip decisions (tier1/2/3).
 * `name` is the full observability label (tier1_firecrawl, etc.).
 * `fetch` returns null on miss/error; the runTier wrapper handles
 * observability recording. `tuning` carries optional CSS-selector hints that
 * tiers honor where they can and ignore otherwise.
 */
export interface Tier {
  name: TierName;
  slot: TierSlot;
  fetch(
    url: string,
    maxChars: number,
    preferFit?: boolean,
    tuning?: FetchTuning,
  ): Promise<TierResult | null>;
}
