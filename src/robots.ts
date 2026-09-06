import robotsParserModule from "robots-parser";
import { cacheGet, cacheSet } from "./cache.js";
import { recordRobotsProbe } from "./domain-db.js";
import { safeFetch } from "./fetch-utils.js";
import { describeTransportFailure } from "./transport-failure.js";

interface RobotsParserResult {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

// robots-parser ships malformed types — CJS module re-typed here for clarity.
const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsParserResult;

const ROBOTS_TTL_SECONDS = 24 * 60 * 60;
// A failure to reach robots.txt is not an answer, so it must not be cached for
// a day like one. It is still cached briefly: a persistently dead host would
// otherwise cost a fresh 5s timeout on every single request through it.
const ROBOTS_ERROR_TTL_SECONDS = 300;
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;

export interface RobotsCheckResult {
  allowed: boolean;
  reason?:
    | "disallowed"
    | "parse_failed"
    | "no_robots_txt"
    | "robots_unreachable";
}

interface CachedRobots {
  body: string | null;
  fetched: string;
  /**
   * Set when robots.txt could not be read. `body: null` alone meant four
   * different things — a 404 (the site really has no robots.txt), a 5xx, a
   * missing response body, and a transport failure — and all four became
   * "no robots.txt, therefore allowed", cached for 24 hours, and recorded into
   * the domain database as a capability fact.
   *
   * So a five-second timeout or a DNS blip wrote "this site permits us to
   * crawl anything" and stood by it for a day. The permissive default is
   * deliberate and unchanged; what changes is that it is now visible as a
   * failure rather than indistinguishable from consent.
   */
  error?: string;
}

function robotsCacheKey(origin: string): string {
  return `robots:${origin}`;
}

async function fetchRobotsTxt(origin: string): Promise<CachedRobots> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    // safeFetch: robots.txt follows redirects, so the DNS-validating dispatcher
    // re-checks each hop against private/reserved addresses.
    const res = await safeFetch(robotsUrl, {
      headers: { "User-Agent": "searxng-mcp" },
      redirect: "follow",
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    // The one case that is a real answer: the site is telling us there is no
    // robots.txt, so there are no rules and everything is permitted.
    if (res.status === 404) {
      return { body: null, fetched: new Date().toISOString() };
    }
    // Anything else is the server declining to tell us. A 503 or a 429 is not
    // permission.
    if (!res.ok) {
      return {
        body: null,
        fetched: new Date().toISOString(),
        error: `HTTP ${res.status}`,
      };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        body: null,
        fetched: new Date().toISOString(),
        error: "response carried no body",
      };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < ROBOTS_MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      .toString("utf-8")
      .slice(0, ROBOTS_MAX_BYTES);
    return { body, fetched: new Date().toISOString() };
  } catch (err) {
    return {
      body: null,
      fetched: new Date().toISOString(),
      error: describeTransportFailure(err, "robots.txt"),
    };
  }
}

export async function getRobotsForOrigin(
  origin: string,
): Promise<CachedRobots> {
  const key = robotsCacheKey(origin);
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as CachedRobots;
    } catch {
      // fall through to fresh fetch on corrupt cache entry
    }
  }
  const fresh = await fetchRobotsTxt(origin);
  // A non-answer gets a short TTL, not a day's. Caching a transport failure
  // for 24h is what turned one bad five-second window into a day of asserting
  // that a site had no crawl rules.
  await cacheSet(
    key,
    JSON.stringify(fresh),
    fresh.error ? ROBOTS_ERROR_TTL_SECONDS : ROBOTS_TTL_SECONDS,
  );
  return fresh;
}

export async function checkRobots(
  url: string,
  userAgent: string,
): Promise<RobotsCheckResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    // Reviewed (vikunja#687 class sweep): a URL we cannot parse is one we will
    // never fetch, so there is nothing to be permitted or refused.
    return { allowed: true };
  }
  const origin = parsedUrl.origin;
  const robots = await getRobotsForOrigin(origin);

  // We could not read robots.txt. Still permissive — failing closed here would
  // stop crawling on every transient blip, and that posture is deliberate — but
  // say which of the two happened, and DO NOT record a capability. Writing
  // "this origin has no robots.txt" into the domain database off the back of a
  // timeout is recording a fabricated fact about a third party's site.
  if (robots.error) {
    console.error(
      `[searxng-mcp] robots.txt unreadable for ${origin}: ${robots.error} — proceeding as allowed, which is NOT the same as the site permitting it`,
    );
    return { allowed: true, reason: "robots_unreachable" };
  }

  if (!robots.body) {
    recordRobotsProbe(origin, false, true).catch(() => {});
    return { allowed: true, reason: "no_robots_txt" };
  }
  try {
    const parser = robotsParser(`${origin}/robots.txt`, robots.body);
    const allowed = parser.isAllowed(url, userAgent);
    if (allowed === false) {
      recordRobotsProbe(origin, true, false).catch(() => {});
      return { allowed: false, reason: "disallowed" };
    }
    recordRobotsProbe(origin, true, true).catch(() => {});
    return { allowed: true };
  } catch {
    // robots-parser threw on a body we DID successfully fetch. Was labelled
    // "fetch_failed", which sent anyone investigating to the network layer.
    return { allowed: true, reason: "parse_failed" };
  }
}
