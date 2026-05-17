// NATS event publishing. Fire-and-forget: with no NATS_URL set, this module
// no-ops and never requires the `nats` package at runtime (type-only imports
// below are erased by tsc).
import type { NatsConnection } from "nats";
import { getRequestId } from "./context.js";
import { getCurrentTraceId } from "./observability.js";

interface BaseEnvelope {
  request_id?: string;
  trace_id?: string;
  ts: string;
}

let nc: NatsConnection | null = null;
let subjectPrefix = "searxng";
let warnedOnce = false;

export async function initEvents(): Promise<void> {
  const url = process.env.NATS_URL;
  if (!url) return;
  subjectPrefix = process.env.NATS_SUBJECT_PREFIX ?? "searxng";

  try {
    const { connect, credsAuthenticator } = await import("nats");
    const opts: Record<string, unknown> = {
      servers: url,
      name: "searxng-mcp",
      reconnect: true,
      maxReconnectAttempts: -1,
    };
    if (process.env.NATS_CREDS) {
      // Lazy-load fs alongside nats so the module stays free of top-level
      // node:fs imports when NATS isn't in use.
      const { readFileSync } = await import("node:fs");
      opts.authenticator = credsAuthenticator(
        readFileSync(process.env.NATS_CREDS),
      );
    }
    nc = await connect(opts);
  } catch (err) {
    if (!warnedOnce) {
      console.error(
        `[searxng-mcp] NATS connect failed (events disabled): ${err instanceof Error ? err.message : String(err)}`,
      );
      warnedOnce = true;
    }
    nc = null;
  }
}

export async function shutdownEvents(): Promise<void> {
  if (!nc) return;
  try {
    await nc.drain();
  } catch {
    // best-effort
  }
  nc = null;
}

function envelope<T extends object>(payload: T): T & BaseEnvelope {
  return {
    ...payload,
    request_id: getRequestId(),
    trace_id: getCurrentTraceId(),
    ts: new Date().toISOString(),
  };
}

export function publishEvent(suffix: string, payload: object): void {
  if (!nc) return;
  try {
    const data = new TextEncoder().encode(JSON.stringify(envelope(payload)));
    nc.publish(`${subjectPrefix}.${suffix}`, data);
  } catch {
    // fire-and-forget — never throw from the event hook
  }
}

// Typed shortcuts mirror the subjects documented in the build plan.
export const events = {
  searchRequested(p: {
    query: string;
    profile?: string;
    expand?: boolean;
    time_range?: string;
    num_results: number;
  }): void {
    publishEvent("search.requested", p);
  },
  searchCompleted(p: {
    result_count: number;
    latency_ms: number;
    sources?: string[];
    rerank_applied: boolean;
  }): void {
    publishEvent("search.completed", p);
  },
  fetchRequested(p: {
    url: string;
    max_chars: number;
    prefer_fit?: boolean;
  }): void {
    publishEvent("fetch.requested", p);
  },
  fetchTierMiss(p: {
    url: string;
    tier: string;
    reason: string;
    latency_ms: number;
  }): void {
    publishEvent("fetch.tier.miss", p);
  },
  fetchTierSkipped(p: { url: string; tier: string; reason: string }): void {
    publishEvent("fetch.tier.skipped", p);
  },
  fetchCompleted(p: {
    url: string;
    tier_served: string;
    title: string;
    text_len: number;
    latency_ms: number;
    source?: string;
  }): void {
    publishEvent("fetch.completed", p);
  },
  cacheHit(p: {
    key_type: string;
    namespace: string;
    age_seconds?: number;
  }): void {
    publishEvent("cache.hit", p);
  },
  cacheMiss(p: { key_type: string; namespace: string }): void {
    publishEvent("cache.miss", p);
  },
  error(p: {
    stage: string;
    url?: string;
    error_type: string;
    message: string;
  }): void {
    publishEvent("error", p);
  },
};
