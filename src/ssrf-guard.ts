// SSRF guard: classify IP addresses as private/reserved and provide an undici
// dispatcher whose connect-time DNS lookup rejects any hostname that resolves
// to such an address.
//
// Why a connect-time lookup rather than resolve-then-fetch: validating the
// hostname string (assertPublicUrl) blocks literal private IPs, but a public
// hostname that resolves to a private address (DNS rebinding) slips past it.
// Pre-resolving and then calling fetch() has a TOCTOU gap — the address the
// resolver returned to us and the one the socket connects to can differ. By
// installing the guard as the dispatcher's `connect.lookup`, the address we
// validate is the exact one undici connects to, and it is re-run for every
// connection the request makes — including each redirect hop — closing both
// the rebinding and TOCTOU gaps.
//
// This module has no project imports so it can be reused from fetch-utils.ts
// (which assertPublicUrl lives in) without an import cycle.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

export class SsrfBlockedError extends Error {
  // The resolved `address` is kept as a property for programmatic use but is
  // deliberately NOT interpolated into the message — surfacing the internal IP
  // a hostname resolved to would leak network topology to the caller/telemetry
  // (OE-02 parity with raw.ts's redirect handling).
  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(
      `Blocked request to ${hostname}: resolves to a private/reserved address`,
    );
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

// Expand any IPv6 form (including `::` compression and a trailing IPv4 tail
// like ::ffff:127.0.0.1) into its 16 constituent bytes. Returns null if the
// string is not a well-formed IPv6 address.
function ipv6ToBytes(ip: string): number[] | null {
  let addr = ip.split("%")[0]; // strip any zone id
  // Fold a trailing dotted-quad into two hextets so the rest parses as pure v6.
  if (addr.includes(".")) {
    const idx = addr.lastIndexOf(":");
    if (idx < 0) return null;
    const v4 = ipv4ToBytes(addr.slice(idx + 1));
    if (!v4) return null;
    const h1 = ((v4[0] << 8) | v4[1]).toString(16);
    const h2 = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, idx + 1)}${h1}:${h2}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  let hextets: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` must stand in for at least one group
    hextets = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    hextets = addr.split(":");
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    const n = Number.parseInt(h, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isPrivateV4(b: number[]): boolean {
  const [a, second, third] = b;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && second === 254) return true; // link-local / cloud metadata
  if (a === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (a === 192 && second === 168) return true; // 192.168.0.0/16
  if (a === 192 && second === 0 && third === 0) return true; // 192.0.0.0/24 IETF
  if (a === 100 && second >= 64 && second <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (second === 18 || second === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 192 && second === 0 && third === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && second === 51 && third === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && second === 0 && third === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a === 192 && second === 88 && third === 99) return true; // 192.88.99.0/24 6to4 relay (deprecated)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function isPrivateV6(b: number[]): boolean {
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  const first = b[0];
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `ip` is a private, loopback, link-local, CGNAT, multicast, or
 * otherwise-reserved address that outbound fetches must never reach. Anything
 * that is not a parseable IP literal is treated as unsafe (returns true) — the
 * caller is expected to pass a resolved address, not a hostname.
 */
export function isPrivateOrReservedAddress(ip: string): boolean {
  const family = isIP(ip.replace(/%.*$/, ""));
  if (family === 4) {
    const bytes = ipv4ToBytes(ip);
    return bytes ? isPrivateV4(bytes) : true;
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true;
    // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4 address.
    if (
      bytes.slice(0, 10).every((x) => x === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff
    ) {
      return isPrivateV4(bytes.slice(12));
    }
    return isPrivateV6(bytes);
  }
  return true; // not an IP literal — unsafe by default
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Wrap a dns.lookup-shaped function so a resolution to any private/reserved
 * address fails the lookup. Exported for direct unit testing; production code
 * uses {@link ssrfGuardedDispatcher}.
 */
export function makeGuardedLookup(baseLookup: typeof dnsLookup = dnsLookup) {
  return (
    hostname: string,
    options: Parameters<typeof dnsLookup>[1],
    callback: LookupCallback,
  ): void => {
    // biome-ignore lint/suspicious/noExplicitAny: dns.lookup overloads don't line up with the generic wrapper signature
    (baseLookup as any)(
      hostname,
      options,
      (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => {
        if (err) return callback(err, address, family);
        const candidates = Array.isArray(address)
          ? address.map((a) => a.address)
          : [address];
        for (const addr of candidates) {
          if (isPrivateOrReservedAddress(addr)) {
            return callback(new SsrfBlockedError(hostname, addr), "", 0);
          }
        }
        callback(err, address, family);
      },
    );
  };
}

/**
 * Shared undici dispatcher for all outbound fetches to caller-influenced or
 * discovered URLs. Its connect-time lookup rejects private/reserved
 * resolutions (see module header). Reused across requests — undici pools
 * connections per origin behind it.
 */
export const ssrfGuardedDispatcher: Dispatcher = new Agent({
  connect: {
    // biome-ignore lint/suspicious/noExplicitAny: undici's connect.lookup type is narrower than the dns.lookup overload set
    lookup: makeGuardedLookup() as any,
  },
});

/**
 * Resolve a URL's hostname and throw if any resolved address is
 * private/reserved. Use this before handing a URL to an **external fetcher**
 * (Firecrawl/Crawl4AI) that resolves and connects on our behalf and therefore
 * can't be covered by {@link ssrfGuardedDispatcher} (which only guards our own
 * connections). Unlike the connect-time guard this has a TOCTOU window — the
 * external service re-resolves later and could get a different answer — but it
 * closes the common DNS-rebinding case (a hostname that stably resolves to an
 * internal address) that the string-level `assertPublicUrl` misses. A
 * resolution failure is not treated as a block: let the downstream fetch
 * surface its own DNS error rather than masking it here.
 */
export async function assertResolvedPublic(url: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("Invalid URL");
  }
  if (isIP(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) {
      throw new SsrfBlockedError(hostname, hostname);
    }
    return;
  }
  let results: LookupAddress[];
  try {
    results = await dnsLookupAsync(hostname, { all: true });
  } catch {
    return; // resolution failure — not an SSRF block
  }
  for (const r of results) {
    if (isPrivateOrReservedAddress(r.address)) {
      throw new SsrfBlockedError(hostname, r.address);
    }
  }
}
