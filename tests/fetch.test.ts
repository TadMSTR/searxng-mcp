import { describe, it, expect } from "vitest";
import { assertPublicUrl } from "../src/fetch.js";

describe("assertPublicUrl", () => {
  it("accepts a normal public HTTPS URL", () => {
    expect(() => assertPublicUrl("https://example.com/page")).not.toThrow();
  });

  it("accepts a normal public HTTP URL", () => {
    expect(() => assertPublicUrl("http://example.com/page")).not.toThrow();
  });

  it("throws on localhost", () => {
    expect(() => assertPublicUrl("http://localhost/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 127.0.0.1", () => {
    expect(() => assertPublicUrl("http://127.0.0.1/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 0.0.0.0", () => {
    expect(() => assertPublicUrl("http://0.0.0.0/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 10.x.x.x", () => {
    expect(() => assertPublicUrl("http://10.0.0.1/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 192.168.x.x", () => {
    expect(() => assertPublicUrl("http://192.168.1.1/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 172.16.x.x (RFC 1918 range)", () => {
    expect(() => assertPublicUrl("http://172.16.0.1/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on 172.31.x.x (RFC 1918 range boundary)", () => {
    expect(() => assertPublicUrl("http://172.31.255.255/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("accepts 172.15.x.x (just outside RFC 1918 range)", () => {
    expect(() => assertPublicUrl("http://172.15.0.1/page")).not.toThrow();
  });

  it("throws on host.docker.internal", () => {
    expect(() => assertPublicUrl("http://host.docker.internal/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on ::1 (IPv6 loopback)", () => {
    expect(() => assertPublicUrl("http://[::1]/page")).toThrow("Internal/private addresses are not allowed");
  });

  it("throws on non-http protocol", () => {
    expect(() => assertPublicUrl("ftp://example.com/page")).toThrow("Only http/https URLs are supported");
  });
});
