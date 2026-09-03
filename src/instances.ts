/**
 * Ordered SearXNG candidate selection with cross-process health hints.
 *
 * `SEARXNG_URL` may name several interchangeable replicas. This module decides
 * what order to try them in, and remembers — across processes — which ones just
 * failed, so a dead primary is not re-tried on the front of every single search
 * until its TTL lapses.
 *
 * Three properties this is built around:
 *
 * 1. **A single instance takes no new code path.** With one candidate there is
 *    nothing to order and nothing to learn: if the only instance is unhealthy
 *    we must try it regardless. So the health lookup is skipped entirely, and a
 *    scalar `SEARXNG_URL` issues exactly one request to exactly one host, with
 *    no added cache round-trip on the hot path. This is the configuration every
 *    existing deployment runs.
 *
 * 2. **Health state lives in the cache, not in a module-level Map.** The value
 *    of the marker is that one process's discovery informs the next call, and
 *    in-process state cannot do that.
 *
 * 3. **It is fail-soft, like the rest of the cache layer.** A cache outage must
 *    degrade to "try every instance in configured order" — never to an error,
 *    and never to an empty candidate list. Losing the cache costs the ordering
 *    optimisation, not the ability to search.
 *
 * Deliberately NOT a circuit breaker: an unhealthy instance is deprioritised,
 * never removed. If every instance is marked unhealthy the full list is still
 * returned in configured order, because "everything looks down" is exactly when
 * you most want to actually try.
 */

import { cacheGet, cacheSet } from "./cache.js";
import { SEARXNG_UNHEALTHY_TTL_SECONDS, SEARXNG_URLS } from "./config.js";
import { logThrottled } from "./log.js";

/**
 * Cache key for an instance's unhealthy marker.
 *
 * Keyed on origin rather than the full URL so a path suffix cannot fragment the
 * marker, and built via `URL` so any userinfo in the configured value is
 * dropped rather than written into a cache key.
 */
export function unhealthyKey(url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  return `searxng:unhealthy:${origin}`;
}

/**
 * Candidates in the order they should be tried: healthy first, then those
 * currently marked unhealthy, each group preserving configured order.
 *
 * Never returns an empty array.
 */
export async function getSearxCandidates(
  instances: readonly string[] = SEARXNG_URLS,
): Promise<string[]> {
  // Single instance: nothing to reorder. Skipping the lookup keeps the
  // hot path free of a cache round-trip that could not change the outcome.
  if (instances.length <= 1) return [...instances];

  const healthy: string[] = [];
  const unhealthy: string[] = [];

  for (const url of instances) {
    let marked = false;
    try {
      marked = (await cacheGet(unhealthyKey(url))) !== null;
    } catch {
      // cacheGet is already fail-soft, but a throw here must not lose the
      // instance — treat an unreadable marker as "no information", i.e. healthy.
      marked = false;
    }
    (marked ? unhealthy : healthy).push(url);
  }

  // All marked down: return configured order rather than an arbitrary one. The
  // markers carry no recency ordering, so "least recently failed" is not
  // available, and configured order is at least the operator's stated
  // preference.
  if (healthy.length === 0) return [...instances];

  return [...healthy, ...unhealthy];
}

/**
 * Record that `url` just failed. Best-effort: a write failure costs the
 * ordering hint for the next call and nothing more.
 */
export async function markUnhealthy(url: string): Promise<void> {
  try {
    await cacheSet(unhealthyKey(url), "1", SEARXNG_UNHEALTHY_TTL_SECONDS);
  } catch {
    // Never throw from a health hint.
  }
}

/**
 * Clear the marker for an instance that has just answered successfully, so a
 * recovered replica returns to the front of the order without waiting out the
 * TTL. Only meaningful with more than one instance.
 */
export async function markHealthy(url: string): Promise<void> {
  try {
    // Writing a 1-second expiry rather than deleting keeps this to the two
    // cache primitives already exposed, and the marker is a hint whose exact
    // expiry does not need to be precise.
    if ((await cacheGet(unhealthyKey(url))) !== null) {
      await cacheSet(unhealthyKey(url), "1", 1);
    }
  } catch {
    // Never throw from a health hint.
  }
}

/**
 * One stderr line when a search falls through to a non-primary instance.
 *
 * Throttled per instance-pair. A silent failover is indistinguishable from a
 * healthy primary, which is how a half-dead deployment goes unnoticed for
 * weeks — but an unthrottled line would emit once per search for as long as
 * the primary stays down.
 */
export function logFailover(from: string, to: string, reason: string): void {
  logThrottled(
    `searxng-failover:${from}->${to}`,
    `SearXNG failover: ${from} failed (${reason}), served by ${to}`,
  );
}
