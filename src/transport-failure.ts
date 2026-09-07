/**
 * Telling a transport failure apart from a data answer.
 *
 * This module exists because the same defect keeps shipping: a backend that is
 * unreachable, unauthenticated or misconfigured produces the *same* value as a
 * backend that answered correctly and had nothing to say. `null` for "the page
 * was empty" and `null` for "the connection was refused" are indistinguishable
 * to every caller, so a total outage reads as a quiet day.
 *
 * Recorded instances, all in this repo, three of them shipped in one week:
 *   #690  runTier booked tier-2 null as empty_result
 *   #691  crawl4ai 0.9.x reports healthy and refuses every connection
 *   #695  capabilities said reranker=on through a 4.5h reranker outage
 *   #688  enumerateDomains returned an empty corpus for an unreachable Valkey
 *   #687  raw.ts / solver.ts bare `catch { return null }`
 *
 * The rule this encodes: **a catch block may return a benign value only when
 * the exception genuinely means the data is absent.** If the exception means
 * "we could not find out", that has to reach the operator.
 */

import { redactUrlCredentialsInText } from "./log.js";

/**
 * Name a transport failure well enough to act on.
 *
 * Node's fetch reports every one of these as the bare string "fetch failed"
 * and hides the useful part on `cause.code`. The distinction is not cosmetic:
 * a crawl4ai 0.9.x server started without CRAWL4AI_API_TOKEN binds the
 * container's loopback and answers published ports with ECONNRESET *while its
 * healthcheck stays green*, and "fetch failed" would leave an investigator no
 * way to tell that from a DNS typo.
 *
 * @param err   the caught value
 * @param label the backend's name, used as the message prefix so a log line
 *              says which dependency failed without the reader needing the
 *              stack
 */
export function describeTransportFailure(err: unknown, label: string): string {
  const base = err instanceof Error ? err.message : String(err);
  const detail = transportErrorCode(err);
  const described = detail
    ? `${label} unreachable: ${detail} (${base})`
    : `${label}: ${base}`;
  // Scrubbed HERE, at the sink, not at the five call sites (vikunja#715).
  //
  // Node's fetch rejects a credentialed URL with the URL in the message, and
  // ioredis does the same for a bad VALKEY_URL — so `base` can carry an inline
  // password, and every one of this function's return paths is a sink that
  // forwards it: a tool result, an MCP Resource, a log line.
  //
  // Measured before choosing: five call sites, one of which redacted. Fixing
  // the caller that #715 named would have closed one and left three
  // (domain-snapshot.ts, robots.ts, tiers/crawl4ai.ts) — which is the same
  // "guarded one path, missed the others" mistake this subsystem has now made
  // twice, and which log.ts already documents as the reason to redact at the
  // generic sink instead. redactUrlCredentialsInText is idempotent, so the
  // call site in resources.ts stays as defence in depth without double-mangling
  // anything.
  return redactUrlCredentialsInText(described);
}

/**
 * The `cause.code` behind a Node fetch rejection, if there is one.
 *
 * `code` is present for the network failures (ECONNRESET, ECONNREFUSED,
 * ENOTFOUND, EAI_AGAIN, …). Some causes carry only a message — Node rejects a
 * request to a blocked port that way — so fall back to it rather than to
 * nothing.
 */
export function transportErrorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })
    ?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return undefined;
}

/**
 * Does this exception mean "we could not reach the dependency", as opposed to
 * "the dependency answered and the answer was unusable"?
 *
 * Deliberately conservative: an AbortError (our own timeout) counts, because a
 * dependency that did not answer inside its budget has not told us anything
 * about the data. A JSON.parse failure does not — that is a reply we could not
 * use, which is a different report to make.
 */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  if (transportErrorCode(err) !== undefined) return true;
  // Node's undici surfaces the generic case with this exact message and puts
  // everything useful on `cause` — which the check above already covered. A
  // bare "fetch failed" with no cause is still a transport failure.
  return err instanceof Error && err.message === "fetch failed";
}

/**
 * Log a swallowed dependency failure on a path whose return type genuinely
 * cannot carry the error.
 *
 * Some call sites are optional enrichment inside a cascade — a Kiwix miss, a
 * Wayback miss — where throwing would convert a degraded result into no result
 * at all. Returning the benign value is correct there; returning it *silently*
 * is what makes an outage invisible. Use this so the failure is at least on
 * stderr with the dependency named.
 *
 * Do NOT use it as a way to keep a bare catch: if the caller can carry the
 * error, give it the error.
 */
export function warnDependencyFailure(err: unknown, label: string): void {
  if (!isTransportFailure(err)) return;
  console.error(
    `[searxng-mcp] ${describeTransportFailure(err, label)} — returning no result for this source; it is unavailable, not empty`,
  );
}
