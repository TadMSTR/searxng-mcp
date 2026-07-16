import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup as dnsLookupAsync } from "node:dns/promises";
import {
  assertResolvedPublic,
  isPrivateOrReservedAddress,
  makeGuardedLookup,
  SsrfBlockedError,
} from "../src/ssrf-guard.js";

describe("isPrivateOrReservedAddress — IPv4", () => {
  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "0.1.2.3",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1", // IETF protocol assignments
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "239.255.255.255",
    "240.0.0.1", // reserved
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "93.184.216.34", // example.com
  ])("allows public %s", (ip) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(false);
  });
});

describe("isPrivateOrReservedAddress — IPv6", () => {
  it.each([
    "::1", // loopback
    "0:0:0:0:0:0:0:1", // full-form loopback
    "::", // unspecified
    "fc00::1", // ULA
    "fd12:3456:789a::1", // ULA
    "fe80::1", // link-local
    "febf::1", // link-local upper bound
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:169.254.169.254", // IPv4-mapped metadata
  ])("blocks %s", (ip) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(true);
  });

  it.each([
    "2606:4700:4700::1111", // Cloudflare
    "2001:4860:4860::8888", // Google
    "::ffff:8.8.8.8", // IPv4-mapped public
  ])("allows public %s", (ip) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(false);
  });
});

describe("isPrivateOrReservedAddress — non-IP input", () => {
  it("treats a hostname (not an IP literal) as unsafe", () => {
    expect(isPrivateOrReservedAddress("example.com")).toBe(true);
    expect(isPrivateOrReservedAddress("not-an-ip")).toBe(true);
  });
});

describe("makeGuardedLookup", () => {
  const opts = { all: false } as const;

  it("passes through a public resolution", async () => {
    const base = vi.fn((_h, _o, cb) => cb(null, "93.184.216.34", 4));
    const guarded = makeGuardedLookup(base as never);
    const result = await new Promise((resolve) =>
      guarded("example.com", opts, (err, addr) => resolve({ err, addr })),
    );
    expect(result).toEqual({ err: null, addr: "93.184.216.34" });
  });

  it("blocks a hostname that resolves to a private address (DNS rebind)", async () => {
    const base = vi.fn((_h, _o, cb) => cb(null, "10.0.0.5", 4));
    const guarded = makeGuardedLookup(base as never);
    const err = await new Promise<Error | null>((resolve) =>
      guarded("rebind.evil", opts, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).address).toBe("10.0.0.5");
  });

  it("blocks when any address in an all:true result is private", async () => {
    const addrs: LookupAddress[] = [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const base = vi.fn((_h, _o, cb) => cb(null, addrs));
    const guarded = makeGuardedLookup(base as never);
    const err = await new Promise<Error | null>((resolve) =>
      guarded("mixed.evil", { all: true }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("propagates an underlying resolver error unchanged", async () => {
    const dnsErr = new Error("ENOTFOUND");
    const base = vi.fn((_h, _o, cb) => cb(dnsErr, "", 0));
    const guarded = makeGuardedLookup(base as never);
    const err = await new Promise<Error | null>((resolve) =>
      guarded("nope.example", opts, (e) => resolve(e)),
    );
    expect(err).toBe(dnsErr);
  });
});

describe("assertResolvedPublic", () => {
  const mockLookup = vi.mocked(dnsLookupAsync);

  it("rejects a literal private IP without resolving", async () => {
    await expect(
      assertResolvedPublic("http://10.0.0.1/admin"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("allows a literal public IP without resolving", async () => {
    await expect(
      assertResolvedPublic("http://93.184.216.34/"),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks a hostname that resolves to a private address (DNS rebind)", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as LookupAddress[]);
    await expect(
      assertResolvedPublic("https://rebind.evil/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
    ] as LookupAddress[]);
    await expect(
      assertResolvedPublic("https://example.com/"),
    ).resolves.toBeUndefined();
  });

  it("does not treat a DNS resolution failure as a block", async () => {
    mockLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(
      assertResolvedPublic("https://nope.example/"),
    ).resolves.toBeUndefined();
  });
});
