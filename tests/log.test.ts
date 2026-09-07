import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logError,
  logThrottled,
  logWarn,
  redactUrlCredentials,
  redactUrlCredentialsInText,
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

describe("redactUrlCredentialsInText — every userinfo shape, not just the colon form", () => {
  // This function is the redaction sink for describeTransportFailure, which as of
  // v3.29.0 feeds FIVE call sites plus warnDependencyFailure. A shape it does not
  // match is a leak on all of them at once, so the shapes are enumerated rather
  // than sampled (audit searxng-mcp-release-hygiene-2026-09, Low).

  it.each([
    [
      "redis://:hunter2@cache.internal:6379",
      "hunter2",
      "inline password — CACHE_URL shape",
    ],
    [
      "https://user:pw@searx.internal/search",
      "pw",
      "basic auth — SEARXNG_URL shape",
    ],
    // The gap the audit found. `scheme://TOKEN@host` has no colon in the userinfo,
    // and the original regex required one. No credential on forge takes this shape
    // today — but it is exactly how a bearer/PAT appears in a URL, and "no live
    // conduit today" is a fact about the present, not a property of the function.
    ["redis://tokenonly@cache.internal:6379", "tokenonly", "bare token"],
    [
      "https://ghp_ABC123def@github.com/o/r.git",
      "ghp_ABC123def",
      "bare token, GitHub PAT shape",
    ],
  ])("redacts %s", (input, secret) => {
    const out = redactUrlCredentialsInText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("<redacted>@");
  });

  // The controls. Without these, a function that redacted every "@" in sight would
  // pass every assertion above — and would quietly mangle ordinary URLs in error
  // text, which is its own kind of unreadable log.
  it.each([
    ["https://github.com/@handle", "an @ in the path is not userinfo"],
    [
      "https://matrix.to/#/@user:server.org",
      "an @ in a fragment is not userinfo",
    ],
    ["https://example.com/search?q=a@b.com", "an @ in a query is not userinfo"],
    ["redis://localhost:6379", "no @ at all"],
    ["plain text with no url", "not a URL"],
  ])("leaves %s untouched", (input) => {
    expect(redactUrlCredentialsInText(input)).toBe(input);
  });

  it("redacts every URL in a message, not only the first", () => {
    const out = redactUrlCredentialsInText(
      "tried redis://:pw1@h1:6379 then https://u:pw2@h2/x",
    );
    expect(out).not.toContain("pw1");
    expect(out).not.toContain("pw2");
    expect(out.match(/<redacted>@/g)).toHaveLength(2);
  });

  it("is idempotent", () => {
    // resources.ts redacts at its own sink as well as inheriting the shared one,
    // so this string genuinely goes through twice on that path.
    const once = redactUrlCredentialsInText(
      "redis://:hunter2@cache.internal:6379",
    );
    expect(redactUrlCredentialsInText(once)).toBe(once);
  });

  it("keeps the host, so the message still diagnoses something", () => {
    const out = redactUrlCredentialsInText(
      "connect to redis://admin:hunter2@cache.internal:6379 failed",
    );
    expect(out).toContain("cache.internal");
    expect(out).toContain("6379");
    expect(out).toContain("connect to");
  });
});
