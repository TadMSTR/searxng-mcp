"use strict";

/**
 * Address classification + resolve-and-pin for the proxy's outbound targets.
 *
 * WHY THIS FILE DUPLICATES src/ssrf-guard.ts
 * ------------------------------------------
 * It is a deliberate, tested duplicate, not drift. searxng-mcp's in-process
 * guard cannot protect this path: when ADBLOCK_PROXY_URL is set (it is, on the
 * deployed container), rawFetch hands undici a ProxyAgent, so safeFetch never
 * installs ssrfGuardedDispatcher and the connect-time DNS check never runs for
 * any proxied fetch. The TCP connection is made *here*, so the connect-time
 * check has to live here too.
 *
 * It cannot import the real module: this is a separate Docker build context
 * (docker/adblock-proxy) that cannot reach ../../src, and that context is set
 * in ~/docker/searxng/docker-compose.yml, which this repo does not own.
 *
 * tests/adblock-proxy-ssrf.test.ts runs BOTH implementations over one shared
 * vector table, so the two cannot diverge silently. If you change the ranges in
 * src/ssrf-guard.ts, that test fails until you change them here.
 *
 * What this closes: previously the CONNECT handler regex-matched the literal
 * hostname string and then called net.connect(port, host), which re-resolved
 * with no rebinding protection — a hostname passing the string check but
 * resolving to an internal address would reach it (SSRF-10). The plain-HTTP
 * path had no address check at all. Both now resolve first, reject on any
 * private/reserved answer, and connect to the *validated address* rather than
 * re-resolving the name — which removes the TOCTOU window rather than narrowing
 * it.
 */

const dns = require("dns").promises;
const net = require("net");

// Hostnames that never legitimately resolve to a public address. Kept as names
// because DNS may happily answer for them; the address check below is the
// primary control.
const PRIVATE_HOSTNAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /^host\.docker\.internal$/i,
];

function ipv4ToBytes(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function ipv6ToBytes(ip) {
  const addr = ip.replace(/%.*$/, "");
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const expand = (part) => (part === "" ? [] : part.split(":"));
  let head = expand(halves[0]);
  let tail = halves.length === 2 ? expand(halves[1]) : [];

  // Trailing IPv4 form (::ffff:127.0.0.1) — expand the dotted quad into two groups.
  const last = (tail.length ? tail : head)[
    (tail.length ? tail : head).length - 1
  ];
  if (last && last.includes(".")) {
    const v4 = ipv4ToBytes(last);
    if (!v4) return null;
    const groups = [
      ((v4[0] << 8) | v4[1]).toString(16),
      ((v4[2] << 8) | v4[3]).toString(16),
    ];
    if (tail.length) tail = tail.slice(0, -1).concat(groups);
    else head = head.slice(0, -1).concat(groups);
  }

  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return null;
    head = head.concat(Array(missing).fill("0"));
  }
  const groups = head.concat(tail);
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isPrivateV4(b) {
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
  if (a === 192 && second === 88 && third === 99) return true; // 192.88.99.0/24 6to4 relay
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(b) {
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if (b.every((x) => x === 0)) return true; // ::
  const first = b[0];
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `ip` is an address outbound proxied traffic must never reach.
 * Anything that is not a parseable IP literal is unsafe by default — callers
 * pass a resolved address, not a hostname.
 */
function isPrivateOrReservedAddress(ip) {
  const family = net.isIP(ip.replace(/%.*$/, ""));
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
  return true;
}

/**
 * Resolve `host` and return an address safe to connect to, or null if the name
 * is internal, unresolvable, or resolves to anything private/reserved.
 *
 * Callers must connect to the RETURNED ADDRESS, not to `host`. Reconnecting by
 * name would re-resolve and reopen the rebinding window this exists to close.
 * A resolution failure returns null (refuse) rather than falling through: at
 * this layer there is no downstream guard left to catch it.
 */
async function resolveSafeAddress(host, lookup = dns.lookup) {
  if (!host) return null;
  const bare = host.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.some((r) => r.test(bare))) return null;

  // An IP literal needs no resolution — classify it directly.
  if (net.isIP(bare)) {
    return isPrivateOrReservedAddress(bare) ? null : bare;
  }

  let results;
  try {
    results = await lookup(bare, { all: true });
  } catch {
    return null;
  }
  if (!Array.isArray(results) || results.length === 0) return null;
  // Every answer must be safe. Picking only the safe ones from a mixed set
  // would let a rebinding name through on whichever address happened to pass.
  for (const r of results) {
    if (!r || typeof r.address !== "string") return null;
    if (isPrivateOrReservedAddress(r.address)) return null;
  }
  return results[0].address;
}

module.exports = {
  isPrivateOrReservedAddress,
  resolveSafeAddress,
  PRIVATE_HOSTNAMES,
};
