// Startup capability reporting. Answers the operator question "why is quality
// worse than I expected" — the most common cause is an optional service that
// was never configured, and until now nothing said so at startup.
//
// This reports *configuration*, never health: nothing here probes a service or
// opens a socket. That has always been true, but until v3.26.0 the line said
// `on=` for a configured-but-uncontacted backend, which an operator reads as
// "working" — and it said `reranker` was on through the whole of a 4.5h
// reranker outage (vikunja#695). Configured-but-unverified now renders as
// `unverified=`, so the line stops making a claim it cannot support.
//
// Actual reachability still shows up on the existing degradation paths
// (rerankWithFallback, the Ollama fallbacks, the throttled cache lines).

import {
  CACHE_URL,
  HISTER_URL,
  KIWIX_URL,
  LLM_BASE_URL,
  OLLAMA_URL,
  RERANKER_URL,
  SOLVER_ENABLED,
  SOLVER_URL,
  tierConfigured,
  WAYBACK_ENABLED,
} from "./config.js";
import { logInfo } from "./log.js";

/**
 * Capability name → whether it is active, in the order it is reported.
 *
 * Tier availability is read from `tierConfigured()` rather than recomputed, so
 * this line and the `not_configured` skips in routing.ts cannot disagree.
 *
 * cache and reranker have a non-empty default URL and no kill switch, so they
 * are always attempted and always report on. Both fail soft (a cache timeout
 * serves live, the reranker falls back to the upstream order), which is why
 * neither is a prerequisite.
 */
export function capabilities(): Record<string, boolean> {
  const tiers = tierConfigured();
  return {
    tier1: tiers.tier1,
    tier2: tiers.tier2,
    tier3: tiers.tier3,
    cache: Boolean(CACHE_URL),
    reranker: Boolean(RERANKER_URL),
    llm: Boolean(LLM_BASE_URL || OLLAMA_URL),
    kiwix: Boolean(KIWIX_URL),
    hister: Boolean(HISTER_URL),
    solver: SOLVER_ENABLED && Boolean(SOLVER_URL),
    wayback: WAYBACK_ENABLED,
    otel: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
    nats: Boolean(process.env.NATS_URL),
  };
}

/**
 * Capabilities whose truth is complete without contacting anything.
 *
 * Everything NOT listed here is backed by a remote dependency this process has
 * not spoken to at startup, so "configured" is all we can honestly claim about
 * it. tier3 is in-process (raw fetch + Readability) and wayback is a plain
 * feature flag; both are as true as they will ever be.
 */
const SELF_CONTAINED = new Set(["tier3", "wayback"]);

export type CapabilityState = "on" | "unverified" | "off";

/**
 * Capability name → what we actually know about it.
 *
 * `on`          configured, and nothing remote has to work for it to be true
 * `unverified`  configured, but this process has never contacted the backend
 * `off`         not configured
 *
 * The distinction is the point (vikunja#695). `Boolean(RERANKER_URL)` says a
 * URL is set, and the line rendered that as `reranker` being *on* right
 * through a 4.5-hour reranker outage — a URL was set the entire time. Nothing
 * here probes, so `unverified` is not a health failure; it is the honest
 * absence of a health claim, and an operator reading it knows the difference
 * between "I did not configure that" and "I configured it and nobody checked".
 */
export function capabilityStates(): Record<string, CapabilityState> {
  const caps = capabilities();
  const states: Record<string, CapabilityState> = {};
  for (const [name, configured] of Object.entries(caps)) {
    states[name] = !configured
      ? "off"
      : SELF_CONTAINED.has(name)
        ? "on"
        : "unverified";
  }
  return states;
}

/** The single startup line. Kept to one line however many capabilities exist. */
export function capabilityLine(): string {
  const states = capabilityStates();
  const names = (want: CapabilityState) =>
    Object.keys(states)
      .filter((k) => states[k] === want)
      .join(",") || "none";
  return `capabilities on=${names("on")} unverified=${names("unverified")} off=${names("off")}`;
}

export function logCapabilities(): void {
  logInfo(capabilityLine());
}
