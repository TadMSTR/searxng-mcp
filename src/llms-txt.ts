import { cacheGet, cacheSet } from "./cache.js";
import { FETCH_CACHE_TTL_SECONDS } from "./config.js";
import { recordLlmsFullProbe } from "./domain-db.js";
import { getLlmsTxtAllowlist } from "./domains.js";
import { readBoundedText, safeFetch } from "./fetch-utils.js";

const PROBE_PRESENT_TTL_SECONDS = 24 * 60 * 60;
const PROBE_ABSENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROBE_PRESENT_TTL_MS = PROBE_PRESENT_TTL_SECONDS * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MIN_SIZE_BYTES = 1_024;
// Ceiling on an accepted llms-full.txt. Was 200 MB — a number no real document
// approaches, and one that was checked only *after* the whole body had been
// buffered. Lowered to 64 MB (Ted, 2026-09-03) against measured sizes of the
// six allowlisted origins: docs.anthropic.com is 40.3 MB, docs.firecrawl.dev
// 0.93 MB, docs.cursor.com 0.49 MB, the rest absent. 64 MB keeps every real
// document on the fast path with room to grow. Note this is a capability
// boundary, not just a memory one: raising or lowering it changes which
// documents the fast path accepts.
const MAX_SIZE_BYTES = 64 * 1024 * 1024;
const USER_AGENT =
  "searxng-mcp/3.8.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)";

// Cap across all domains for the in-process L1 body cache, deliberately tied
// to MAX_SIZE_BYTES: any document the fetch path accepts must be one the cache
// can hold. These were previously two independently chosen numbers (10 MB vs
// 200 MB) that disagreed, and the gap between them was a live pathology —
// docs.anthropic.com at 40.3 MB was accepted, written to Valkey, and then
// refused by L1 on every single session, so the 40 MB round trip was paid
// every time and the cache it was meant to warm never held it.
//
// Enforced in bytes (see l1Set), matching the constant's name. It was
// previously enforced with body.length, a UTF-16 character count.
const L1_MAX_BYTES = MAX_SIZE_BYTES;

interface CachedLlmsFull {
  status: "present" | "absent";
  body?: string;
  fetched: string;
}

// In-process L1 cache: avoids redundant large Valkey reads within a session.
// Valkey is the authoritative body store; L1 is a hot-read layer only.
const bodyCache = new Map<string, { body: string; expiresAt: number }>();
let bodyCacheTotalBytes = 0;

function l1Set(origin: string, body: string, ttlMs: number): void {
  const size = Buffer.byteLength(body, "utf-8");
  // A body larger than the whole cache can never be inserted. Check before
  // evicting anything: the eviction loop below would otherwise drain every
  // other entry trying to make room that cannot exist, so one oversized
  // document flushed the entire cache and still did not get stored.
  if (size > L1_MAX_BYTES) return;

  const existing = bodyCache.get(origin);
  if (existing) {
    bodyCacheTotalBytes -= Buffer.byteLength(existing.body, "utf-8");
    bodyCache.delete(origin);
  }
  // Evict oldest entries until there is room for the new body.
  while (bodyCacheTotalBytes + size > L1_MAX_BYTES && bodyCache.size > 0) {
    const oldest = bodyCache.keys().next().value;
    if (!oldest) break;
    const entry = bodyCache.get(oldest);
    if (entry) bodyCacheTotalBytes -= Buffer.byteLength(entry.body, "utf-8");
    bodyCache.delete(oldest);
  }
  if (bodyCacheTotalBytes + size <= L1_MAX_BYTES) {
    bodyCache.set(origin, { body, expiresAt: Date.now() + ttlMs });
    bodyCacheTotalBytes += size;
  }
}

export function _clearBodyCacheForTests(): void {
  bodyCache.clear();
  bodyCacheTotalBytes = 0;
}

export function isLlmsTxtDomain(url: string, allowlist?: string[]): boolean {
  const list = allowlist ?? getLlmsTxtAllowlist();
  if (list.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
  return list.some((pat) => hostname === pat || hostname.endsWith(`.${pat}`));
}

function llmsProbeCacheKey(origin: string): string {
  return `llms:${origin}:full`;
}

function llmsBodyCacheKey(origin: string): string {
  return `llms:${origin}:body`;
}

async function fetchLlmsFullTxt(origin: string): Promise<CachedLlmsFull> {
  try {
    const res = await safeFetch(`${origin}/llms-full.txt`, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { status: "absent", fetched: new Date().toISOString() };
    }
    // Read one byte PAST the ceiling, deliberately. Capping at exactly
    // MAX_SIZE_BYTES would truncate an oversized document to exactly the
    // limit, the size check below would then pass, and a partial
    // llms-full.txt would be served as if it were the whole document — a
    // worse bug than the unbounded read this replaces. The extra byte is what
    // lets an oversized document still be *detected* as oversized and fall
    // through to the tier cascade as `absent`.
    const body = await readBoundedText(res, MAX_SIZE_BYTES + 1);
    // Byte-based, matching the constants' own names. The previous check used
    // body.length, a UTF-16 character count, against byte thresholds.
    const size = Buffer.byteLength(body, "utf-8");
    if (size < MIN_SIZE_BYTES || size > MAX_SIZE_BYTES) {
      return { status: "absent", fetched: new Date().toISOString() };
    }
    return { status: "present", body, fetched: new Date().toISOString() };
  } catch {
    return { status: "absent", fetched: new Date().toISOString() };
  }
}

async function getLlmsFullTxt(origin: string): Promise<CachedLlmsFull> {
  // L1 hit?
  const local = bodyCache.get(origin);
  if (local && local.expiresAt > Date.now()) {
    return { status: "present", body: local.body, fetched: "" };
  }

  // Valkey body hit? Body is stored separately under llms:<origin>:body.
  const bodyKey = llmsBodyCacheKey(origin);
  const cachedBody = await cacheGet(bodyKey);
  if (cachedBody) {
    l1Set(origin, cachedBody, PROBE_PRESENT_TTL_MS);
    return { status: "present", body: cachedBody, fetched: "" };
  }

  // Probe flag: if we know the domain is absent, skip the network fetch.
  const flagKey = llmsProbeCacheKey(origin);
  const cachedFlag = await cacheGet(flagKey);
  if (cachedFlag) {
    try {
      const meta = JSON.parse(cachedFlag) as CachedLlmsFull;
      if (meta.status === "absent") return meta;
      // status: present but body evicted from Valkey — fall through to refetch.
    } catch {
      // corrupt cache entry — refetch
    }
  }

  const fresh = await fetchLlmsFullTxt(origin);
  const probeTtl =
    fresh.status === "present"
      ? PROBE_PRESENT_TTL_SECONDS
      : PROBE_ABSENT_TTL_SECONDS;

  // Store probe flag (present/absent, no body).
  await cacheSet(
    flagKey,
    JSON.stringify({ status: fresh.status, fetched: fresh.fetched }),
    probeTtl,
  );

  // Store body in Valkey and warm L1.
  if (fresh.status === "present" && fresh.body) {
    await cacheSet(bodyKey, fresh.body, FETCH_CACHE_TTL_SECONDS);
    l1Set(origin, fresh.body, PROBE_PRESENT_TTL_MS);
  }

  recordLlmsFullProbe(
    origin,
    fresh.status === "present",
    fresh.body?.length,
  ).catch(() => {});
  return fresh;
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

function pathsMatch(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  // Cross-host docs may list pages under a different prefix (e.g. Anthropic
  // serves docs.anthropic.com/<path> but the llms-full.txt URL line points
  // at platform.claude.com/docs/<path>). Accept a suffix match either way.
  return na.endsWith(nb) || nb.endsWith(na);
}

interface LlmsTxtMatch {
  title?: string;
  text: string;
}

const URL_LINE_GLOBAL = /^URL:\s*(\S+)/gm;
const HEADING_LINK = /^(#{1,6})\s+\[([^\]]+)\]\(([^)]+)\)/gm;

function extractByUrlLine(
  content: string,
  requestedUrl: string,
): LlmsTxtMatch | null {
  const requestedPath = normalizePath(new URL(requestedUrl).pathname);

  // Collect every `URL:` line — each marks the start of a logical page.
  // Pages can contain inner `---` separators around their sub-sections, so we
  // can't just split on `---` and expect one page per chunk.
  URL_LINE_GLOBAL.lastIndex = 0;
  const urlMatches: Array<{ index: number; url: string }> = [];
  for (;;) {
    const m = URL_LINE_GLOBAL.exec(content);
    if (m === null) break;
    urlMatches.push({ index: m.index, url: m[1] });
  }

  for (let i = 0; i < urlMatches.length; i++) {
    const { index, url } = urlMatches[i];
    try {
      const sectionPath = normalizePath(new URL(url).pathname);
      if (!pathsMatch(sectionPath, requestedPath)) continue;

      // Start: walk back to the previous `---` separator (or file start).
      const before = content.slice(0, index);
      const lastSepIdx = before.lastIndexOf("\n---");
      const startIdx = lastSepIdx >= 0 ? lastSepIdx + 1 : 0;

      // End: walk forward to the next `URL:` line, then back up to the
      // `---` separator that introduces it. End-of-file if no next page.
      let endIdx: number;
      if (i + 1 < urlMatches.length) {
        const nextIdx = urlMatches[i + 1].index;
        const between = content.slice(0, nextIdx);
        const sepBeforeNext = between.lastIndexOf("\n---");
        endIdx = sepBeforeNext > index ? sepBeforeNext + 1 : nextIdx;
      } else {
        endIdx = content.length;
      }

      const segment = content.slice(startIdx, endIdx);
      const titleMatch = /^#\s+(.+)$/m.exec(segment);
      return {
        title: titleMatch?.[1]?.trim(),
        text: segment.replace(/^---+\r?\n*/, "").trim(),
      };
    } catch {
      // skip malformed URLs
    }
  }
  return null;
}

function extractByHeadingLink(
  content: string,
  requestedUrl: string,
): LlmsTxtMatch | null {
  const requestedPath = normalizePath(new URL(requestedUrl).pathname);
  HEADING_LINK.lastIndex = 0;
  for (;;) {
    const m = HEADING_LINK.exec(content);
    if (m === null) break;
    const headingLevel = m[1].length;
    const title = m[2].trim();
    const linkUrl = m[3];
    let linkPath: string;
    try {
      linkPath = normalizePath(new URL(linkUrl, requestedUrl).pathname);
    } catch {
      continue;
    }
    if (!pathsMatch(linkPath, requestedPath)) continue;

    const sectionStart = m.index;
    const tail = content.slice(m.index + m[0].length);
    const endRegex = new RegExp(`^#{1,${headingLevel}}\\s`, "m");
    const endMatch = endRegex.exec(tail);
    const sectionEnd = endMatch
      ? m.index + m[0].length + endMatch.index
      : content.length;
    return {
      title,
      text: content.slice(sectionStart, sectionEnd).trim(),
    };
  }
  return null;
}

export function extractSection(
  content: string,
  requestedUrl: string,
): LlmsTxtMatch | null {
  return (
    extractByUrlLine(content, requestedUrl) ??
    extractByHeadingLink(content, requestedUrl)
  );
}

export interface LlmsTxtResult {
  title: string;
  url: string;
  text: string;
  source: "llms_full_txt";
}

export async function tryLlmsTxtFetch(
  url: string,
  maxChars: number,
  allowlist?: string[],
): Promise<LlmsTxtResult | null> {
  if (!isLlmsTxtDomain(url, allowlist)) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const cached = await getLlmsFullTxt(origin);
  if (cached.status !== "present" || !cached.body) return null;

  const section = extractSection(cached.body, url);
  if (!section) return null;

  return {
    title: section.title ?? url,
    url,
    text: section.text.slice(0, maxChars),
    source: "llms_full_txt",
  };
}
