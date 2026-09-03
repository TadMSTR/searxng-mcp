// Shared primitives used by both src/fetch.ts (orchestrator) and src/tiers/*.ts
// (tier handlers). Kept here to avoid circular imports — fetch.ts imports
// from ./tiers/index.js, so tier files cannot import back from ./fetch.js.

import { isIP } from "node:net";
import type { Dispatcher } from "undici";
import {
  isPrivateOrReservedAddress,
  ssrfGuardedDispatcher,
} from "./ssrf-guard.js";
import { VERSION } from "./version.js";

export const USER_AGENT = `searxng-mcp/${VERSION} (+https://github.com/TadMSTR/searxng-mcp; personal research)`;

// Hard cap on HTML bytes read into memory per fetch. Anything larger than
// this is dropped — the metadata extractors aren't useful on multi-megabyte
// rendered pages anyway, and uncapped reads make the JSDOM constructor a
// memory-amplification target (IV-14).
export const RAW_HTML_MAX_BYTES = 2 * 1024 * 1024;

export interface TierResult {
  title: string;
  url: string;
  text: string;
  html?: string;
}

// Hostnames that never resolve to a public address. Literal IPs are handled by
// isPrivateOrReservedAddress; these are name-only cases DNS resolution wouldn't
// necessarily catch on every host.
const BLOCKED_HOSTNAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /^host\.docker\.internal$/i,
];

/**
 * String-level SSRF guard: reject non-http(s) URLs and any hostname that is a
 * private/reserved IP literal or a known-internal name. This is the first line
 * of defence; the connect-time DNS guard (safeFetch / ssrfGuardedDispatcher)
 * catches public hostnames that resolve to private addresses.
 */
export function assertPublicUrl(url: string): void {
  const parsed = new URL(url);
  // http:// is intentionally permitted: Wayback Machine snapshots, some legacy
  // sites, and local service integrations (Kiwix, Firecrawl) may use non-TLS
  // URLs. Private addresses are blocked below regardless of scheme.
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Only http/https URLs are supported`);
  }
  // Strip IPv6 brackets so isIP / classification see the bare address.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) {
      throw new Error(`Internal/private addresses are not allowed`);
    }
    return;
  }
  if (BLOCKED_HOSTNAMES.some((r) => r.test(hostname))) {
    throw new Error(`Internal/private addresses are not allowed`);
  }
}

// Optional CSS-selector tuning passed through fetch_url to the tiers that can
// honor it. Tiers that cannot (fast paths, raw HTTP wait_for) ignore the
// fields rather than erroring.
export interface FetchTuning {
  targetSelector?: string;
  waitForSelector?: string;
}

type SafeFetchOptions = Parameters<typeof fetch>[1] & {
  dispatcher?: Dispatcher;
};

/**
 * fetch() wrapper for outbound requests to caller-influenced or discovered
 * URLs. Applies the string-level guard, then routes through the DNS-validating
 * dispatcher (which also re-validates every redirect hop) unless the caller
 * supplied its own dispatcher (e.g. the adblock proxy, which resolves at the
 * proxy — the string guard still applies there).
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  assertPublicUrl(url);
  const opts: SafeFetchOptions = { ...options };
  if (!opts.dispatcher) opts.dispatcher = ssrfGuardedDispatcher;
  return fetch(url, opts);
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * Read a response body as text, stopping at `limit` bytes and cancelling the
 * rest of the stream. Use this for every body read of third-party content:
 * `res.text()` buffers the whole thing first, so a post-hoc size check has
 * already paid the memory cost it is trying to avoid.
 *
 * The bound is on **bytes retained**, not bytes transferred. Cancellation is
 * not instantaneous — socket buffers and in-flight data mean the peer may
 * still push past the cap — so this reduces transfer (measured ~10x against a
 * 40 MB stub) while hard-bounding what is held in memory.
 *
 * Truncation is byte-based throughout: the accumulated buffer is cut to
 * `limit` bytes before decoding, so the unit matches what the loop counts. A
 * multi-byte UTF-8 sequence straddling the boundary decodes to U+FFFD, which
 * is the honest result for a truncated document.
 *
 * @param res   Response to read. A response with no readable stream (204, 304,
 *              HEAD) yields "" — those genuinely have no body, and failing
 *              closed here is the point: an unbounded `res.text()` fallback
 *              would reintroduce the exact defect this helper exists to fix.
 * @param limit Maximum bytes to retain. Defaults to RAW_HTML_MAX_BYTES (2 MB).
 */
export async function readBoundedText(
  res: Response,
  limit: number = RAW_HTML_MAX_BYTES,
): Promise<string> {
  const cap = Math.max(0, Math.floor(limit));
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  // Drop any in-flight remainder if we hit the cap.
  reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  // Byte-based truncation: the loop may overshoot by at most one chunk, and
  // `total` counts bytes, so the cut must too. A character-based .slice() here
  // would be a no-op on multi-byte content.
  return (buf.byteLength > cap ? buf.subarray(0, cap) : buf).toString("utf-8");
}
