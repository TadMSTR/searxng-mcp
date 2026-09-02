// Challenge-solving tier. Hands a challenged URL to a headless-browser solver
// (Byparr on forge), then replays the solved session through the normal reader.
//
// Built against the FlareSolverr v1 contract — POST /v1 taking
// {cmd, url, maxTimeout} and returning {solution: {url, status, cookies,
// userAgent}} — which Byparr implements (src/endpoints.py, src/models.py).
// Byparr is the deployed solver because it is actively released and
// FlareSolverr's browser-and-wait approach is documented as failing on
// Turnstile and Managed Challenge; sharing the contract means adding
// FlareSolverr later is configuration, not code.
//
// Expect this tier to miss often. Byparr's own README states a bypass is not
// guaranteed and frequently needs residential-IP traffic. A failure here is a
// clean miss that degrades into tier4_wayback — it is not an error path.

import { ChallengeDetectedError } from "../challenge.js";
import {
  SOLVER_ENABLED,
  SOLVER_MAX_TIMEOUT_MS,
  SOLVER_URL,
} from "../config.js";
import {
  assertPublicUrl,
  type FetchTuning,
  readBoundedText,
  type TierResult,
} from "../fetch-utils.js";
import { assertResolvedPublic } from "../ssrf-guard.js";
import { type RawFetchHeaders, rawFetch } from "./raw.js";

interface SolverCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
}

interface SolverSolution {
  url?: unknown;
  status?: unknown;
  cookies?: unknown;
  userAgent?: unknown;
}

/**
 * Cookie name/value characters a solver may hand back. Everything else is
 * dropped rather than escaped: these values are attacker-influenced (the solver
 * is repeating what a remote origin set) and they are being concatenated into a
 * request header, where CR/LF, quotes, comma, semicolon or backslash would let
 * one cookie forge additional pairs. Escaping belongs to the destination, and
 * the destination here has no escaping — so the only safe move is to refuse.
 */
function isSafeCookieToken(v: string): boolean {
  if (v.length === 0) return false;
  if (hasControlChars(v)) return false;
  return !/[\s",;\\]/.test(v);
}

/**
 * CR, LF and other control characters are what turn a concatenated header into
 * header injection. Checked by code point rather than by regex character class
 * so the intent is legible and no lint suppression is needed.
 */
function hasControlChars(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `cookieDomain` covers `host`. A solved session's cookies are only
 * ever replayed to the host they were issued for — a solver-returned cookie is
 * never forwarded to another origin.
 */
function cookieAppliesTo(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  if (!d) return false;
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Build a Cookie header from the solver's jar, scoped to `host` and stripped of
 * anything unsafe to serialise. Returns null when nothing survives.
 */
export function buildScopedCookieHeader(
  cookies: unknown,
  host: string,
): string | null {
  if (!Array.isArray(cookies)) return null;
  const pairs: string[] = [];
  for (const raw of cookies as SolverCookie[]) {
    if (!raw || typeof raw !== "object") continue;
    const { name, value, domain } = raw;
    if (typeof name !== "string" || typeof value !== "string") continue;
    // A cookie with no domain is a session cookie for the host we asked about.
    const scope = typeof domain === "string" && domain ? domain : host;
    if (!cookieAppliesTo(scope, host)) continue;
    if (!isSafeCookieToken(name) || !isSafeCookieToken(value)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/**
 * Solve a challenge for `url` and return the replayed page, or null on any
 * miss.
 *
 * Inert unless SOLVER_ENABLED and SOLVER_URL are both set. The caller is
 * responsible for only invoking this when a challenge was actually detected —
 * see the gate in fetchPage.
 */
export async function solverFetch(
  url: string,
  maxChars = 8000,
  tuning?: FetchTuning,
): Promise<TierResult | null> {
  if (!SOLVER_ENABLED || !SOLVER_URL) return null;

  let res: Response;
  try {
    // The solver's own address is an internal service name on a stack-owned
    // bridge network, so this call deliberately bypasses safeFetch — its
    // public-address guard would reject the solver itself. The guard that
    // matters is on the replay below, which is the outbound fetch.
    res = await fetch(`${SOLVER_URL}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "request.get",
        url,
        maxTimeout: SOLVER_MAX_TIMEOUT_MS,
      }),
      // The solver is an internal service and should never redirect. If a
      // misconfigured SOLVER_URL points at something that does, following it
      // would be an unguarded fetch to wherever it pointed — so don't.
      redirect: "manual",
      // Outlast the solver's own budget so a solver that is working right up to
      // its deadline still gets to answer, but never hang unbounded.
      signal: AbortSignal.timeout(SOLVER_MAX_TIMEOUT_MS + 10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let solution: SolverSolution;
  try {
    // readBoundedText caps the read at RAW_HTML_MAX_BYTES (2 MB). The solver
    // echoes the solved page back in `solution.response`, which we never use,
    // so an oversized body is truncated and fails JSON.parse into a miss rather
    // than being read into memory unbounded.
    const body = await readBoundedText(res);
    const data = JSON.parse(body) as { solution?: SolverSolution };
    if (!data.solution || typeof data.solution !== "object") return null;
    solution = data.solution;
  } catch {
    return null;
  }

  // Failing to solve is the common case, not an exception: a solver that
  // returns the challenge page itself reports a non-2xx origin status.
  const status = typeof solution.status === "number" ? solution.status : 0;
  if (status < 200 || status >= 300) return null;

  const solvedUrl = typeof solution.url === "string" ? solution.url : url;

  // ── SSRF: the replay is the new exposure ────────────────────────────────────
  // fetchPage already ran assertResolvedPublic(url) once before dispatching the
  // cascade, which covers handing the URL to the solver — same treatment tier1
  // and tier2 get (see the note in fetch.ts). But the solver follows redirects
  // on our behalf and reports where it ended up, so `solution.url` is a fresh,
  // solver-controlled address that no guard has seen. Validate it here, before
  // it is fetched, whether or not the host changed. Like the tier1/tier2 guard
  // this leaves a TOCTOU window — the name is resolved again by the replay
  // fetch and could answer differently — but it closes the case that matters: a
  // solver redirecting us onto an internal address.
  try {
    assertPublicUrl(solvedUrl);
    await assertResolvedPublic(solvedUrl);
  } catch {
    console.error(
      "[searxng-mcp] solver replay rejected — solved URL failed the SSRF guard",
    );
    return null;
  }

  let solvedHost: string;
  try {
    solvedHost = new URL(solvedUrl).hostname;
  } catch {
    return null;
  }

  const headers: RawFetchHeaders = {};
  if (typeof solution.userAgent === "string" && solution.userAgent.trim()) {
    // A solved Cloudflare session is bound to the browser identity that solved
    // it; replaying under our own User-Agent re-triggers the challenge.
    if (isSafeHeaderValue(solution.userAgent)) {
      headers["User-Agent"] = solution.userAgent;
    }
  }
  const cookieHeader = buildScopedCookieHeader(solution.cookies, solvedHost);
  if (cookieHeader) headers.Cookie = cookieHeader;

  // Replay through the normal bounded reader rather than returning the solver's
  // own HTML: `solution.response` would bypass the size bound, the content-type
  // routing and the extraction path. rawFetch also re-runs challenge detection,
  // so a "solved" page that is still an interstitial throws
  // ChallengeDetectedError and is booked as a miss rather than cached.
  try {
    return await rawFetch(solvedUrl, maxChars, tuning, headers);
  } catch (err) {
    if (err instanceof ChallengeDetectedError) throw err;
    return null;
  }
}

/**
 * Header values are attacker-influenced for the same reason cookies are: the
 * solver is repeating a User-Agent string it was handed.
 */
function isSafeHeaderValue(v: string): boolean {
  return v.length > 0 && !hasControlChars(v);
}
