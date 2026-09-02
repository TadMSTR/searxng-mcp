// Cloudflare-style challenge detection.
//
// Why this exists: runTier() (src/fetch.ts) books any non-null TierResult as a
// hit, with no content validation beyond truthiness. rawFetch throws on
// !res.ok, so a 403/503 challenge is already an error — but an interstitial
// served with HTTP 200 (routine for Managed Challenge and Turnstile) passes
// res.ok, is Readability-extracted, booked as a tier success, cached for
// FETCH_CACHE_TTL_SECONDS (259200 on the deployed container, i.e. three days),
// and written to domain-db as evidence that the tier works on that domain —
// which then feeds tier-skip decisions. Detecting the interstitial turns that
// false hit into a distinguishable miss.
//
// Scope is deliberately narrow: this identifies *challenges*, not low-quality
// pages. runTier's "any non-null is a hit" contract is load-bearing for the
// whole cascade, and general content-quality heuristics do not belong here.

/** Which rule matched. `marker` names the specific signal, for logs and tests. */
export type ChallengeKind = "status_headers" | "interstitial_body";

export interface ChallengeSignal {
  kind: ChallengeKind;
  marker: string;
}

/**
 * The miss reason recorded for a detected challenge. Distinct from the generic
 * `empty_result` on purpose: the solver gate in fetchPage fires on this reason
 * and nothing else, and an operator reading domain-db needs to tell "the tier
 * came back empty" apart from "the origin refused to serve us content".
 */
export const CHALLENGE_MISS_REASON = "challenge_detected";

/**
 * Thrown by a tier that fetched a challenge instead of content. runTier
 * translates it into a miss (not an error) carrying CHALLENGE_MISS_REASON.
 * The message deliberately carries only the marker, never the URL or any
 * response header — it flows into events and the domain-db fail reason.
 */
export class ChallengeDetectedError extends Error {
  readonly signal: ChallengeSignal;

  constructor(signal: ChallengeSignal) {
    super(`Challenge detected (${signal.marker})`);
    this.name = "ChallengeDetectedError";
    this.signal = signal;
  }
}

// Only the head of the body is scanned. A real interstitial is a few KB and
// carries its markers in the <head> and the inline challenge script; bounding
// the scan means a large honest page that happens to mention one of these
// strings far down the document is not misread as a challenge.
const BODY_SCAN_LIMIT = 64 * 1024;

const BODY_MARKERS: readonly { marker: string; re: RegExp }[] = [
  // Cloudflare's interstitial sets <title>Just a moment...</title>. Matching
  // the bare phrase anywhere in the body would fail the negative control —
  // "just a moment" is ordinary English prose. Scoping it to the title element
  // keeps the marker while leaving an honest page that uses the phrase a hit.
  { marker: "title:just-a-moment", re: /<title[^>]*>\s*just a moment/i },
  // Challenge-platform identifiers. These are Cloudflare-internal names that do
  // not occur in prose, so a plain substring match is safe for them.
  { marker: "cf-chl", re: /cf-chl/i },
  { marker: "challenge-platform", re: /challenge-platform/i },
  { marker: "_cf_chl_opt", re: /_cf_chl_opt/i },
];

/** True when the response came back through Cloudflare's edge. */
function isCloudflareEdge(headers: Headers | null | undefined): boolean {
  if (!headers) return false;
  if (headers.get("cf-ray")) return true;
  return /cloudflare/i.test(headers.get("server") ?? "");
}

/**
 * Identify a challenge response. Returns null for anything that looks like
 * ordinary content — over-matching turns honest pages into misses, which is
 * worse than the bug this closes.
 *
 * `headers` and `body` are both optional: a tier that only has one of them
 * (Crawl4AI and Firecrawl return a rendered document with no origin headers)
 * passes null for the other.
 */
export function detectChallenge(
  status: number,
  headers?: Headers | null,
  body?: string | null,
): ChallengeSignal | null {
  // Status alone is not sufficient — plenty of honest 403s exist. Require the
  // response to have come from a Cloudflare edge as well.
  if ((status === 403 || status === 503) && isCloudflareEdge(headers)) {
    return { kind: "status_headers", marker: `status_${status}` };
  }
  if (body) {
    const head = body.slice(0, BODY_SCAN_LIMIT);
    for (const { marker, re } of BODY_MARKERS) {
      if (re.test(head)) return { kind: "interstitial_body", marker };
    }
  }
  return null;
}

/**
 * Throw if any of the supplied document bodies carries a challenge marker.
 *
 * Used by the tiers that go through an external fetcher: they hand back a
 * rendered document with no origin status or headers, so only the body rules
 * can apply. Callers pass every representation they hold (rendered HTML and
 * extracted text) because the markers live in the markup, which the
 * markdown/text projection strips.
 */
export function assertNoChallengeBody(
  ...bodies: (string | null | undefined)[]
): void {
  for (const body of bodies) {
    const signal = detectChallenge(200, null, body);
    if (signal) throw new ChallengeDetectedError(signal);
  }
}
