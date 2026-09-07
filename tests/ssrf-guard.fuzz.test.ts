// Property-based tests for the SSRF guard.
//
// The guard's contract is asymmetric, and the tests are shaped around that: a
// FALSE NEGATIVE (a private address classified as safe) is an SSRF hole, while
// a false positive is only a refused fetch. So the properties below are almost
// all of the form "this must never be classified safe", generated across the
// whole of each reserved range rather than at a handful of hand-picked
// addresses.
//
// Example-based tests already cover the specific addresses someone thought of.
// What they cannot cover is the address nobody thought of — an unusual spelling
// of a range that IS handled, which is how SSRF guards actually fail. Hence the
// representation-equivalence properties at the bottom: the same address written
// two legal ways must classify the same, whatever that classification is.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isPrivateOrReservedAddress } from "../src/ssrf-guard.js";

const u8 = fc.integer({ min: 0, max: 255 });
const v4 = (a: fc.Arbitrary<number>, b = u8, c = u8, d = u8) =>
  fc.tuple(a, b, c, d).map(([w, x, y, z]) => `${w}.${x}.${y}.${z}`);

describe("isPrivateOrReservedAddress — never classifies a reserved range as safe", () => {
  const RANGES: Array<[string, fc.Arbitrary<string>]> = [
    ["0.0.0.0/8 this-network", v4(fc.constant(0))],
    ["10.0.0.0/8 private", v4(fc.constant(10))],
    ["127.0.0.0/8 loopback", v4(fc.constant(127))],
    [
      "169.254.0.0/16 link-local + cloud metadata",
      v4(fc.constant(169), fc.constant(254)),
    ],
    [
      "172.16.0.0/12 private",
      v4(fc.constant(172), fc.integer({ min: 16, max: 31 })),
    ],
    ["192.168.0.0/16 private", v4(fc.constant(192), fc.constant(168))],
    [
      "100.64.0.0/10 CGNAT",
      v4(fc.constant(100), fc.integer({ min: 64, max: 127 })),
    ],
    [
      "198.18.0.0/15 benchmark",
      v4(fc.constant(198), fc.integer({ min: 18, max: 19 })),
    ],
    ["224.0.0.0/4 multicast and above", v4(fc.integer({ min: 224, max: 255 }))],
  ];

  for (const [label, arb] of RANGES) {
    it(`${label}`, () => {
      fc.assert(
        fc.property(arb, (ip) => {
          expect(isPrivateOrReservedAddress(ip)).toBe(true);
        }),
        { numRuns: 500 },
      );
    });
  }

  // CGNAT is called out separately because it is the range that most often
  // gets missed: Python's ipaddress.is_private did not include 100.64.0.0/10
  // until 3.12.4, and guards ported from that assumption inherit the gap.
  it("100.64.0.0/10 is covered across its full span, and 100.63/100.128 are not swept in", () => {
    fc.assert(
      fc.property(fc.integer({ min: 64, max: 127 }), u8, u8, (b, c, d) => {
        expect(isPrivateOrReservedAddress(`100.${b}.${c}.${d}`)).toBe(true);
      }),
      { numRuns: 300 },
    );
    // Neighbours must NOT be blocked — otherwise the range assertion above
    // would also pass for a guard that blocks all of 100.0.0.0/8.
    expect(isPrivateOrReservedAddress("100.63.255.255")).toBe(false);
    expect(isPrivateOrReservedAddress("100.128.0.0")).toBe(false);
  });
});

describe("isPrivateOrReservedAddress — IPv6", () => {
  const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));

  it("fc00::/7 unique-local is never safe", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0xfc00, max: 0xfdff }).map((n) => n.toString(16)),
        fc.array(hextet, { minLength: 7, maxLength: 7 }),
        (head, rest) => {
          expect(isPrivateOrReservedAddress([head, ...rest].join(":"))).toBe(
            true,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("fe80::/10 link-local is never safe", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0xfe80, max: 0xfebf }).map((n) => n.toString(16)),
        fc.array(hextet, { minLength: 7, maxLength: 7 }),
        (head, rest) => {
          expect(isPrivateOrReservedAddress([head, ...rest].join(":"))).toBe(
            true,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("ff00::/8 multicast is never safe", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0xff00, max: 0xffff }).map((n) => n.toString(16)),
        fc.array(hextet, { minLength: 7, maxLength: 7 }),
        (head, rest) => {
          expect(isPrivateOrReservedAddress([head, ...rest].join(":"))).toBe(
            true,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  // The bypass this check exists for: an IPv4-mapped v6 address is a legal way
  // to write a v4 address, and a guard that only classifies v6 prefixes would
  // wave ::ffff:127.0.0.1 straight through.
  it("IPv4-mapped v6 inherits the embedded v4 classification, in BOTH spellings", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          v4(fc.constant(10)),
          v4(fc.constant(127)),
          v4(fc.constant(192), fc.constant(168)),
          v4(fc.constant(169), fc.constant(254)),
        ),
        (ip) => {
          const [a, b, c, d] = ip.split(".").map(Number);
          const hex = `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
          expect(isPrivateOrReservedAddress(`::ffff:${ip}`)).toBe(true);
          expect(isPrivateOrReservedAddress(hex)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a mapped PUBLIC v4 is not blocked — the control for the mapping test above", () => {
    // Without this, a guard that blanket-blocks every ::ffff: address would
    // satisfy the previous property while being uselessly broad.
    expect(isPrivateOrReservedAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedAddress("::ffff:5db8:d822")).toBe(false);
  });
});

describe("isPrivateOrReservedAddress — total function, fail-closed", () => {
  it("never throws, on any string at all", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => isPrivateOrReservedAddress(s)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws on adversarially IP-shaped strings", () => {
    const ipish = fc.stringMatching(/^[0-9a-fA-F.:%[\]]{0,48}$/);
    fc.assert(
      fc.property(ipish, (s) => {
        expect(() => isPrivateOrReservedAddress(s)).not.toThrow();
      }),
      { numRuns: 3000 },
    );
  });

  it("anything that is not a parseable IP literal is unsafe", () => {
    fc.assert(
      // Strings containing a character no IP literal can hold.
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /[g-zG-Z_\-/\\ ]/.test(s)),
        (s) => {
          expect(isPrivateOrReservedAddress(s)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  // Alternative integer encodings of 127.0.0.1. Node's isIP() rejects all of
  // these, so they fall through to the "not an IP literal" branch and are
  // unsafe — which is the correct outcome, but for a different reason than a
  // reader might assume. Pinned so a future "helpful" normalisation that starts
  // accepting them cannot silently reclassify them as safe.
  it("decimal, octal and hex encodings of loopback stay unsafe", () => {
    for (const s of [
      "2130706433", // decimal
      "0177.0.0.1", // octal
      "0x7f.0.0.1", // hex
      "0x7f000001",
      "127.1", // short form
      "127.0.1",
    ]) {
      expect(isPrivateOrReservedAddress(s), s).toBe(true);
    }
  });

  it("a trailing dot or a zone id cannot turn a private address safe", () => {
    fc.assert(
      fc.property(fc.oneof(v4(fc.constant(10)), v4(fc.constant(127))), (ip) => {
        expect(isPrivateOrReservedAddress(`${ip}.`)).toBe(true);
        expect(isPrivateOrReservedAddress(`${ip}%eth0`)).toBe(true);
      }),
      { numRuns: 300 },
    );
    expect(isPrivateOrReservedAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateOrReservedAddress("::1%1")).toBe(true);
  });
});

describe("isPrivateOrReservedAddress — representation equivalence", () => {
  // The strongest property here. Two legal spellings of the SAME address must
  // classify identically, whichever way that goes. A parser bug that mishandles
  // `::` compression shows up here even in a range the guard never intended to
  // treat specially, which is precisely the case a range-by-range test misses.
  it("compressed and fully-expanded v6 forms agree", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), {
          minLength: 8,
          maxLength: 8,
        }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 2, max: 8 }),
        (groups, start, len) => {
          const expanded = groups
            .map((g) => g.toString(16).padStart(4, "0"))
            .join(":");
          // Zero a run, then write the same address using `::` for that run.
          const end = Math.min(start + len, 8);
          if (end - start < 2) return;
          const zeroed = groups.map((g, i) => (i >= start && i < end ? 0 : g));
          const expandedZeroed = zeroed
            .map((g) => g.toString(16).padStart(4, "0"))
            .join(":");
          const head = zeroed
            .slice(0, start)
            .map((g) => g.toString(16))
            .join(":");
          const tail = zeroed
            .slice(end)
            .map((g) => g.toString(16))
            .join(":");
          const compressed = `${head}::${tail}`;
          expect(isPrivateOrReservedAddress(compressed)).toBe(
            isPrivateOrReservedAddress(expandedZeroed),
          );
          // And the untouched address parses at all.
          expect(() => isPrivateOrReservedAddress(expanded)).not.toThrow();
        },
      ),
      { numRuns: 1500 },
    );
  });

  it("hex case does not change the classification", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), {
          minLength: 8,
          maxLength: 8,
        }),
        (groups) => {
          const s = groups.map((g) => g.toString(16)).join(":");
          expect(isPrivateOrReservedAddress(s.toLowerCase())).toBe(
            isPrivateOrReservedAddress(s.toUpperCase()),
          );
        },
      ),
      { numRuns: 800 },
    );
  });

  // This one is worth reading before trusting it, because the obvious reading
  // is wrong.
  //
  // Mutation testing the suite above found one survivor: changing
  // `if (missing < 1)` to `missing < 0` in ipv6ToBytes, which lets `::` stand
  // in for ZERO groups. The natural response is "add a test for a malformed
  // `::` address" — so that is what these four strings are, and the test does
  // NOT kill that mutant. Verified, not assumed: it was re-run with the mutant
  // applied and stayed green.
  //
  // The reason is that `isPrivateOrReservedAddress` calls `isIP()` first, and
  // Node's isIP returns 0 for every one of these (checked directly). So the
  // function returns `true` at the family check and ipv6ToBytes is never
  // reached with them at all. The `missing < 1` clause is unreachable through
  // the public API — defensive redundancy sitting behind a stricter check, not
  // a coverage gap. It is left in place; a parser that is strict on its own
  // terms is worth more than one line of dead-code cleanup.
  //
  // What this test DOES pin is the observable contract, which is the thing
  // callers depend on: a malformed address is unsafe, whichever layer decides
  // it. That holds regardless of which of the two checks fires.
  it("a `::` standing in for zero groups is malformed, and stays unsafe", () => {
    for (const s of [
      "1:2:3:4:5:6:7::8", // 8 hextets plus a `::` — one group too many
      "0:0:0:0:0:0:0:0::",
      "::1:2:3:4:5:6:7:8",
      "1:2:3:4:5:6:7:8::9",
    ]) {
      expect(isPrivateOrReservedAddress(s), s).toBe(true);
    }
  });

  it("leading zeros in a v6 hextet do not change the classification", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), {
          minLength: 8,
          maxLength: 8,
        }),
        (groups) => {
          const bare = groups.map((g) => g.toString(16)).join(":");
          const padded = groups
            .map((g) => g.toString(16).padStart(4, "0"))
            .join(":");
          expect(isPrivateOrReservedAddress(bare)).toBe(
            isPrivateOrReservedAddress(padded),
          );
        },
      ),
      { numRuns: 800 },
    );
  });
});
