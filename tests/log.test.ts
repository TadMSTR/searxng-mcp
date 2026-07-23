import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logError,
  logThrottled,
  logWarn,
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
