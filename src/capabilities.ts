// Startup capability reporting. Answers the operator question "why is quality
// worse than I expected" — the most common cause is an optional service that
// was never configured, and until now nothing said so at startup.
//
// This reports *configuration*, never health: nothing here probes a service or
// opens a socket. A capability listed as on can still be unreachable, and that
// shows up separately on the existing degradation paths (rerankWithFallback,
// the Ollama fallbacks, the throttled cache lines).

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

/** The single startup line. Kept to one line however many capabilities exist. */
export function capabilityLine(): string {
  const caps = capabilities();
  const on = Object.keys(caps).filter((k) => caps[k]);
  const off = Object.keys(caps).filter((k) => !caps[k]);
  return `capabilities on=${on.join(",") || "none"} off=${off.join(",") || "none"}`;
}

export function logCapabilities(): void {
  logInfo(capabilityLine());
}
