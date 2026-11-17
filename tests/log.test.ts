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
    // and the original regex required one. No configured credential may take this
    // shape today — but it is exactly how a bearer/PAT appears in a URL, and "no live
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

  // Passwords pasted unencoded. Node echoes the configured URL as written, so
  // a raw '@' or '/' in a password reaches the error text intact. Stopping at
  // the first '@' left the tail of the first shape; stopping at the first '/'
  // left all of the second.
  it.each([
    ["https://u:p@ss@host.example/x", "p@ss", "raw '@' in the password"],
    ["https://u:pa/ss@host.example/x", "pa/ss", "raw '/' in the password"],
    ["https://u:a/b@c@host.example/x", "a/b@c", "raw '/' and '@'"],
    ["https://u:pa/ss@host.example", "pa/ss", "raw '/', no path after"],
  ])("redacts %s (%s)", (input, secret) => {
    const out = redactUrlCredentialsInText(input);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(-2));
    expect(out).toContain("@host.example");
  });

  it.each([
    "https://u:p@ss@host.example/search?q=x",
    "https://u:pa/ss@host.example/search?q=x",
  ])("redacts Node's own fetch() error for %s", async (url) => {
    // The text that actually reaches the sinks, not a hand-written copy of it.
    const err = await fetch(url).then(
      () => new Error("fetch unexpectedly succeeded"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("ss@host.example");
    const out = redactUrlCredentialsInText(err.message);
    // Nothing of the password survives: the redaction runs to the host.
    expect(out).toContain("://<redacted>@host.example/search?q=x");
  });

  // A password holding '@' and then '/', or a `x://`. The first cut at the
  // password's own '@' and left the rest; the second started a new URL at the
  // inner scheme and left everything before it.
  it.each([
    ["https://u:ab@cd.ef/gh@host.example/x", "ab@cd.ef/gh", "'@' then '/'"],
    ["https://u:ab@cd/ef@gh@host.example/x", "ab@cd/ef@gh", "'@', '/', '@'"],
    ["https://u:abx://cd@host.example/x", "abx://cd", "a `x://` inside"],
    ["https://u:ab:x://cd@host.example/x", "ab:x://cd", "':' then `x://`"],
  ])("redacts %s (%s)", (input) => {
    expect(redactUrlCredentialsInText(input)).toBe(
      "https://<redacted>@host.example/x",
    );
  });

  it.each([
    "https://u:ab@cd.ef/gh@host.example/search?q=x",
    "https://u:abx://cd@host.example/search?q=x",
  ])("redacts Node's own fetch() error for %s", async (url) => {
    const err = await fetch(url).then(
      () => new Error("fetch unexpectedly succeeded"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain(url); // Node echoes the URL as written
    const out = redactUrlCredentialsInText(err.message);
    // From the outer scheme on: an inner `x://` must not restart the scrub.
    expect(out).toContain("https://<redacted>@host.example/search?q=x");
    expect(out).not.toContain("u:ab");
  });

  it("still scrubs a credentialed URL nested in a clean one", () => {
    // Judging a run from its first scheme must not hide a second URL inside
    // it: the outer URL has nothing to redact, so the inner one is judged.
    expect(
      redactUrlCredentialsInText(
        "https://a.example/r?to=https://u:pw@b.example/x",
      ),
    ).toBe("https://a.example/r?to=https://<redacted>@b.example/x");
  });

  // Over-redaction, accepted: with credentials in the authority, a later '@'
  // in the path moves the cut to it, since the password may hold '@' + '/'.
  it("redacts to a path '@' when the authority has credentials", () => {
    expect(redactUrlCredentialsInText("https://u:pw@host.example/a/@b/c")).toBe(
      "https://<redacted>@b/c",
    );
  });

  // Delimiters inside a password: the cut is still at the '@' before the host.
  it.each([
    ["https://u:p?ss@host.example/x", "'?'"],
    ["https://u:p#ss@host.example/x", "'#'"],
    ["https://u:p/?ss@host.example/x", "'/?'"],
    ["https://u:p%40ss@host.example/x", "percent-encoded '@'"],
  ])("redacts %s (%s in the password)", (input) => {
    expect(redactUrlCredentialsInText(input)).toBe(
      "https://<redacted>@host.example/x",
    );
  });

  // With no '/' before it, an '@' after a host's '?' or '#' may be a query or
  // fragment value. Cutting at it would leave the value's tail as the host, so
  // the whole URL is redacted.
  it.each([
    "https://host.example?password=a@b",
    "https://host.example:8080?password=a@b",
    "https://host.example#frag@x",
    "https://host.example?password=a@b/path",
    // With credentials too: a '?' or '#' between the first '@' and a later
    // one may be a query or fragment value holding '@'.
    "https://u:p@host.example?x=a@b",
    "https://u:p@host.example/p?q=a@b",
    "https://u:pa/ss@host.example#f@x",
    "https://u:p@ss?x@host.example",
  ])("redacts all of %s (ambiguous '@' after '?' or '#')", (input) => {
    const out = redactUrlCredentialsInText(input);
    expect(out).toBe("https://<redacted>");
    expect(redactUrlCredentialsInText(out)).toBe(out);
  });

  // A space ends the URL, so a password holding one is not scrubbed
  // (CHANGELOG 3.32.0 says so). Pinned so a change to it is a decision.

  it("leaves a password holding a space (documented limit)", () => {
    expect(redactUrlCredentialsInText("https://u:pa ss@host.example/x")).toBe(
      "https://u:pa ss@host.example/x",
    );
  });

  // Controls for the ambiguous-authority rule: an authority that is a real
  // host[:port] keeps its path '@', so ports, IPv6 and paths stay readable.
  it.each([
    "http://localhost:8080/users/@me",
    "http://[::1]:8080/@x",
    "https://host.example:/a@b",
    "https://github.com/o/r/blob/main/@scope/pkg.json",
    // The documented limit (CHANGELOG 3.32.0): digits before an unencoded '/'
    // read as a port, so this password shape is not scrubbed.
    "https://u:1234/rest@host.example",
    // The same rule: an empty password, or a token holding '/', reads as a
    // host, and Node parses it as one, with no credentials.
    "https://u:/rest@host.example",
    "https://to/ken@host.example",
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

// Every combination of the delimiters a pasted password can hold, in every
// suffix shape, in bare and embedded text. Nothing of the password, or of a
// query or fragment value holding '@', may survive, except the documented
// limit: an authority before the first '/' that reads as host[:port] with no
// '@' (CHANGELOG 3.32.0), which Node also parses as a host with no
// credentials.
describe("redactUrlCredentialsInText — password delimiter table", () => {
  const pieces = ["@", "/", "?", "#", ":", "x://", "%40", "/?"];
  const suffixes = [
    "",
    "/p",
    "/p?q=1",
    "?q=1",
    "#f",
    "/p@z",
    "/p?q=QA@QB",
    "?q=QA@QB",
    "#QA@QB",
  ];
  const hostPort = /^(\[[^\]]*\]|[^:]*)(:\d*)?$/;
  const urls: string[] = [];
  for (const a of pieces)
    for (const b of ["", ...pieces])
      for (const user of ["u:", ""])
        for (const sfx of suffixes)
          urls.push(
            `https://${user}SA${a}SB${b}${b ? "SC" : ""}@host.example${sfx}`,
          );

  it("leaves no password text outside the documented limit", () => {
    const leaks: string[] = [];
    let limited = 0;
    for (const url of urls) {
      const auth = url.slice("https://".length).split("/")[0];
      if (!auth.includes("@") && hostPort.test(auth)) {
        limited++;
        continue;
      }
      for (const msg of [url, `includes credentials: ${url}`, `a ${url} b`]) {
        const out = redactUrlCredentialsInText(msg);
        if (/S[ABC]|Q[AB]/.test(out)) leaks.push(`${url} -> ${out}`);
        if (redactUrlCredentialsInText(out) !== out)
          leaks.push(`re-scrub ${url}`);
      }
    }
    expect(leaks).toEqual([]);
    // The table must exercise the redacting side, not only the limit.
    expect(urls.length - limited).toBeGreaterThan(900);
  });
});

// IV-78: the scheme run used to be unbounded, so dotted text with no `://`
// was quadratic on long dotted text. boundRelayedText runs this over
// upstream error text before truncating, so the input size is the upstream's.
describe("redactUrlCredentialsInText — linear on adversarial text", () => {
  it.each([
    ["dots, no scheme separator", "a.".repeat(100_000)],
    [
      "a long scheme-looking run before ://",
      `${"a.".repeat(100_000)}x://${"b".repeat(1000)}`,
    ],
    ["many short schemes", "a.a.a.a.x://bbbb ".repeat(12_000)],
    ["schemes back to back, no whitespace", "x://".repeat(50_000)],
    ["one token of '@' and '/'", `x://u:${"a/@".repeat(66_000)}`],
    ["ambiguous authority, long token", `x://u:p${"/a@".repeat(66_000)}`],
    ["back-to-back schemes ending in '@'", `${"x://".repeat(50_000)}@`],
    ["nested clean URLs ending in '@'", `${"x://h/".repeat(33_000)}@`],
    ["many '@' segments", "x://u:a@b/c@d ".repeat(14_000)],
    ["inner schemes in a password", `x://u:${"ax://".repeat(40_000)}@h`],
    ["'@' after a host's '?', back to back", "x://h?a@".repeat(25_000)],
  ])("%s: 200 KB in well under a second", (_name, input) => {
    const t0 = performance.now();
    redactUrlCredentialsInText(input);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("still redacts a scheme at the 63-character cap", () => {
    const scheme = `s${"x".repeat(62)}`;
    expect(redactUrlCredentialsInText(`${scheme}://u:pw@h`)).toBe(
      `${scheme}://<redacted>@h`,
    );
  });
});
