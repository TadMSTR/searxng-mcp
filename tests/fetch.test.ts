import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, rawFetch } from "../src/fetch.js";
import { isPdfUrl } from "../src/fetch-utils.js";

describe("assertPublicUrl", () => {
  it("accepts a normal public HTTPS URL", () => {
    expect(() => assertPublicUrl("https://example.com/page")).not.toThrow();
  });

  it("accepts a normal public HTTP URL", () => {
    expect(() => assertPublicUrl("http://example.com/page")).not.toThrow();
  });

  it("throws on localhost", () => {
    expect(() => assertPublicUrl("http://localhost/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 127.0.0.1", () => {
    expect(() => assertPublicUrl("http://127.0.0.1/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 0.0.0.0", () => {
    expect(() => assertPublicUrl("http://0.0.0.0/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 10.x.x.x", () => {
    expect(() => assertPublicUrl("http://10.0.0.1/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 192.168.x.x", () => {
    expect(() => assertPublicUrl("http://192.168.1.1/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 172.16.x.x (RFC 1918 range)", () => {
    expect(() => assertPublicUrl("http://172.16.0.1/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 172.31.x.x (RFC 1918 range boundary)", () => {
    expect(() => assertPublicUrl("http://172.31.255.255/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("accepts 172.15.x.x (just outside RFC 1918 range)", () => {
    expect(() => assertPublicUrl("http://172.15.0.1/page")).not.toThrow();
  });

  it("throws on host.docker.internal", () => {
    expect(() => assertPublicUrl("http://host.docker.internal/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on ::1 (IPv6 loopback)", () => {
    expect(() => assertPublicUrl("http://[::1]/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [0:0:0:0:0:0:0:1] (IPv6 full-form loopback, bracket notation)", () => {
    expect(() => assertPublicUrl("http://[0:0:0:0:0:0:0:1]/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [fc00::] (IPv6 ULA fc range, bracket notation)", () => {
    expect(() => assertPublicUrl("http://[fc00::]/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [fd00::] (IPv6 ULA fd range, bracket notation)", () => {
    expect(() => assertPublicUrl("http://[fd00::]/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [fe80::] (IPv6 link-local, bracket notation)", () => {
    expect(() => assertPublicUrl("http://[fe80::]/page")).toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on non-http protocol", () => {
    expect(() => assertPublicUrl("ftp://example.com/page")).toThrow(
      "Only http/https URLs are supported",
    );
  });
});

describe("rawFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses internal/private addresses (SSRF-08 defensive guard)", async () => {
    // The export shouldn't be a footgun — even if a caller bypasses fetchPage,
    // the SSRF guard fires.
    await expect(rawFetch("http://10.0.0.1/admin")).rejects.toThrow(
      /Internal\/private addresses are not allowed/,
    );
    // fetch should never be called when assertPublicUrl throws first.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns readable prose when Readability parses successfully", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        `<html><head><title>Test Article</title></head><body><article><p>Article content here with enough text to parse.</p></article></body></html>`,
        { status: 200 },
      ),
    );
    const result = await rawFetch("https://example.com/article");
    expect(result.url).toBe("https://example.com/article");
    expect(result.title).toBe("Test Article");
    expect(result.text).not.toMatch(/<[^>]+>/); // no HTML tags — Readability extracted prose
    expect(result.text).toContain("Article content");
  });

  it("falls back to raw HTML when Readability returns null", async () => {
    // A minimal page Readability won't parse as an article (no content body)
    const html = `<html><body><div class="app" id="root"></div></body></html>`;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(html, { status: 200 }));
    const result = await rawFetch("https://example.com/spa");
    expect(result.url).toBe("https://example.com/spa");
    // Falls back to raw html slice
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("html");
  });

  it("throws on redirect", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/other" },
      }),
    );
    const err = await rawFetch("https://example.com/page").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Redirect not followed/);
    // Sanitized error message must not echo the Location header back to the
    // caller — would surface internal addresses on a misconfigured redirect (OE-02).
    expect(err.message).not.toContain("example.com/other");
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );
    await expect(rawFetch("https://example.com/missing")).rejects.toThrow(
      "Raw fetch error: 404",
    );
  });
});

describe("isPdfUrl", () => {
  it("returns true for .pdf URL", () => {
    expect(isPdfUrl("https://example.com/doc.pdf")).toBe(true);
  });

  it("returns true for .PDF URL (case-insensitive)", () => {
    expect(isPdfUrl("https://example.com/doc.PDF")).toBe(true);
  });

  it("returns false for non-PDF URL", () => {
    expect(isPdfUrl("https://example.com/page.html")).toBe(false);
  });

  it("returns false for URL with .pdf in query string but not path", () => {
    expect(isPdfUrl("https://example.com/view?file=doc.pdf")).toBe(false);
  });

  it("returns false for invalid URL", () => {
    expect(isPdfUrl("not a url")).toBe(false);
  });
});
