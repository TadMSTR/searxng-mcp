import robotsParserModule from "robots-parser";
import { cacheGet, cacheSet } from "./cache.js";
import { recordRobotsProbe } from "./domain-db.js";

interface RobotsParserResult {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

// robots-parser ships malformed types — CJS module re-typed here for clarity.
const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsParserResult;

const ROBOTS_TTL_SECONDS = 24 * 60 * 60;
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;

export interface RobotsCheckResult {
  allowed: boolean;
  reason?: "disallowed" | "fetch_failed" | "no_robots_txt";
}

interface CachedRobots {
  body: string | null;
  fetched: string;
}

function robotsCacheKey(origin: string): string {
  return `robots:${origin}`;
}

async function fetchRobotsTxt(origin: string): Promise<CachedRobots> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": "searxng-mcp" },
      redirect: "follow",
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { body: null, fetched: new Date().toISOString() };
    }
    if (!res.ok) {
      return { body: null, fetched: new Date().toISOString() };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return { body: null, fetched: new Date().toISOString() };
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
  } catch {
    return { body: null, fetched: new Date().toISOString() };
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
  await cacheSet(key, JSON.stringify(fresh), ROBOTS_TTL_SECONDS);
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
    return { allowed: true };
  }
  const origin = parsedUrl.origin;
  const robots = await getRobotsForOrigin(origin);
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
    return { allowed: true, reason: "fetch_failed" };
  }
}
