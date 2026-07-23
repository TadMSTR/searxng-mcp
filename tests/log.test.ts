import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logError,
  logThrottled,
  logWarn,
  redactUrlCredentials,
  resetLogThrottle,
} from "../src/log.js";

describe("log helpers", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetLogThrottle();
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it("logError/logWarn write to stderr with the [searxng-mcp] prefix", () => {
    logError("boom");
    logWarn("careful");
    expect(errSpy).toHaveBeenNthCalledWith(1, "[searxng-mcp] boom");
    expect(errSpy).toHaveBeenNthCalledWith(2, "[searxng-mcp] careful");
  });

  it("logThrottled dedupes repeats for the same key within the interval", () => {
    logThrottled("k", "first");
    logThrottled("k", "second");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("[searxng-mcp] first");
  });

  it("logThrottled logs distinct keys independently", () => {
    logThrottled("a", "msg a");
    logThrottled("b", "msg b");
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it("logThrottled logs again once the interval elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    logThrottled("k", "first", 1000);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    logThrottled("k", "second", 1000);
    expect(errSpy).toHaveBeenCalledTimes(2);
  });
});

describe("redactUrlCredentials", () => {
  it("redacts an inline password but keeps host/port/db", () => {
    const out = redactUrlCredentials(
      "redis://:606cadcfsecret@localhost:6381/1",
    );
    expect(out).not.toContain("606cadcfsecret");
    expect(out).toContain("***");
    expect(out).toContain("localhost:6381");
    expect(out).toContain("/1");
  });

  it("redacts a user:password pair while keeping the username", () => {
    const out = redactUrlCredentials("redis://user:hunter2@cache:6379");
    expect(out).toContain("user");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("***");
  });

  it("leaves a credential-free URL unchanged", () => {
    expect(redactUrlCredentials("redis://localhost:6381")).toBe(
      "redis://localhost:6381",
    );
  });

  it("returns a placeholder for an unparseable value", () => {
    expect(redactUrlCredentials("not a url")).toBe("<url>");
  });
});
