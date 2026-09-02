// adblock-proxy's SSRF guard, and its parity with src/ssrf-guard.ts.
//
// docker/adblock-proxy/ssrf.js is a deliberate duplicate of the address
// classifier: the proxy is a separate Docker build context that cannot import
// ../../src, and when ADBLOCK_PROXY_URL is set — it is, on the deployed
// container — rawFetch hands undici a ProxyAgent, so safeFetch never installs
// ssrfGuardedDispatcher and the in-process connect-time check never runs for
// any proxied fetch. The TCP connection is made in the proxy, so the guard has
// to be there too.
//
// Duplication that nothing checks is drift waiting to happen, so both
// implementations run over ONE vector table below, and each is asserted against
// the EXPECTED classification rather than merely against each other — two
// implementations agreeing on a wrong answer is still a wrong answer.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { isPrivateOrReservedAddress as guardIsPrivate } from "../src/ssrf-guard.js";

const require_ = createRequire(import.meta.url);
const proxySsrf = require_("../docker/adblock-proxy/ssrf.js") as {
  isPrivateOrReservedAddress: (ip: string) => boolean;
  resolveSafeAddress: (
    host: string,
    lookup?: (h: string, o: unknown) => Promise<{ address: string }[]>,
  ) => Promise<string | null>;
};

// [address, isPrivateOrReserved]
const VECTORS: readonly [string, boolean][] = [
  // Public — must stay reachable.
  ["93.184.216.34", false],
  ["1.1.1.1", false],
  ["172.15.0.1", false], // just below RFC1918 172.16/12
  ["172.32.0.1", false], // just above
  ["100.63.255.255", false], // just below CGNAT
  ["100.128.0.0", false], // just above CGNAT
  ["198.17.255.255", false], // just below benchmark range
  ["2606:4700:4700::1111", false],

  // IPv4 private / reserved.
  ["0.0.0.0", true],
  ["10.0.0.1", true],
  ["127.0.0.1", true],
  ["169.254.169.254", true], // cloud metadata — the one the old regex list missed
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["192.168.1.1", true],
  ["192.0.0.1", true],
  ["100.64.0.1", true], // CGNAT — also missed by the old regex list
  ["100.127.255.255", true],
  ["198.18.0.1", true],
  ["192.0.2.1", true],
  ["198.51.100.1", true],
  ["203.0.113.1", true],
  ["192.88.99.1", true],
  ["224.0.0.1", true],
  ["255.255.255.255", true],

  // IPv6 private / reserved.
  ["::1", true],
  ["::", true],
  ["fc00::1", true],
  ["fd00::1", true],
  ["fe80::1", true],
  ["ff02::1", true],
  ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
  ["::ffff:169.254.169.254", true],

  // Not an IP literal — unsafe by default.
  ["example.com", true],
  ["", true],
  ["not-an-address", true],
];

describe("adblock-proxy ssrf.js — address classification", () => {
  it.each(VECTORS)("classifies %s", (ip, expected) => {
    expect(proxySsrf.isPrivateOrReservedAddress(ip)).toBe(expected);
  });
});

describe("parity with src/ssrf-guard.ts", () => {
  it.each(VECTORS)("src/ssrf-guard agrees on %s", (ip, expected) => {
    expect(guardIsPrivate(ip)).toBe(expected);
  });

  it("both implementations classify every vector identically", () => {
    // Belt and braces: if a range is ever added to one file and not the other,
    // the per-vector assertions above catch it for known addresses and this
    // catches it for the table as a whole.
    const disagreements = VECTORS.filter(
      ([ip]) => proxySsrf.isPrivateOrReservedAddress(ip) !== guardIsPrivate(ip),
    ).map(([ip]) => ip);
    expect(disagreements).toEqual([]);
  });
});

describe("resolveSafeAddress", () => {
  const lookup = (answers: string[]) => async () =>
    answers.map((address) => ({ address }));

  it("returns the resolved address for a public name", async () => {
    expect(
      await proxySsrf.resolveSafeAddress(
        "example.com",
        lookup(["93.184.216.34"]),
      ),
    ).toBe("93.184.216.34");
  });

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    // The case the whole change exists for: the name passes any string-level
    // check, but resolves inside. Previously net.connect(port, host) would have
    // reached it.
    expect(
      await proxySsrf.resolveSafeAddress(
        "rebind.example.com",
        lookup(["10.0.0.5"]),
      ),
    ).toBeNull();
  });

  it("refuses a name that resolves to cloud metadata", async () => {
    expect(
      await proxySsrf.resolveSafeAddress(
        "meta.example.com",
        lookup(["169.254.169.254"]),
      ),
    ).toBeNull();
  });

  it("refuses when ANY answer is private, not just the first", async () => {
    // Taking the first safe answer from a mixed set would let a rebinding name
    // through on whichever address happened to pass.
    expect(
      await proxySsrf.resolveSafeAddress(
        "mixed.example.com",
        lookup(["93.184.216.34", "10.0.0.5"]),
      ),
    ).toBeNull();
  });

  it("refuses internal hostnames without resolving them", async () => {
    const never = async () => {
      throw new Error("lookup must not be called");
    };
    expect(await proxySsrf.resolveSafeAddress("localhost", never)).toBeNull();
    expect(
      await proxySsrf.resolveSafeAddress("host.docker.internal", never),
    ).toBeNull();
    expect(
      await proxySsrf.resolveSafeAddress("foo.localhost", never),
    ).toBeNull();
  });

  it("classifies an IP literal directly without resolving", async () => {
    const never = async () => {
      throw new Error("lookup must not be called");
    };
    expect(await proxySsrf.resolveSafeAddress("93.184.216.34", never)).toBe(
      "93.184.216.34",
    );
    expect(await proxySsrf.resolveSafeAddress("10.0.0.5", never)).toBeNull();
    expect(await proxySsrf.resolveSafeAddress("[::1]", never)).toBeNull();
  });

  it("refuses on resolution failure rather than falling through", async () => {
    // At this layer there is no downstream guard left to catch it, so an
    // unresolvable name is refused rather than passed to connect.
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(
      await proxySsrf.resolveSafeAddress("nope.example.com", failing),
    ).toBeNull();
  });

  it("refuses an empty answer set", async () => {
    expect(
      await proxySsrf.resolveSafeAddress("empty.example.com", lookup([])),
    ).toBeNull();
  });

  it("refuses an empty host", async () => {
    expect(
      await proxySsrf.resolveSafeAddress("", lookup(["93.184.216.34"])),
    ).toBeNull();
  });
});
