// Credentials must not survive a transport failure into anything a caller reads.
//
// This is the sink-level counterpart to the `stats://domains` case in
// resources.test.ts. That one guards ONE path; this one guards the function all
// five paths go through.
//
// Why the sink and not the call sites (vikunja#715): describeTransportFailure has
// five callers and, before this file existed, exactly one of them redacted —
// resources.ts, fixed in round 1. The other four returned the raw err.message:
//
//   src/domain-stats.ts:318      unavailable  -> domain_stats tool output
//   src/domain-snapshot.ts:257   failed
//   src/robots.ts:104            error
//   src/tiers/crawl4ai.ts:450    described
//
// Fixing at the call site would have closed one and left three, which is exactly
// the "guarded one path, missed the others" pattern src/log.ts already warns
// about and which this subsystem has now hit twice. So the redaction lives in
// describeTransportFailure, and these tests assert it there — plus at the tool
// boundary, because a sink guarantee nobody checks end-to-end is a guarantee
// about a function, not about the product.
import { describe, expect, it, vi } from "vitest";
import {
  describeTransportFailure,
  warnDependencyFailure,
} from "../src/transport-failure.js";

/** An ioredis/undici-shaped rejection carrying a credentialed URL. */
function credentialedError(code?: string) {
  const err = new Error(
    "connect to redis://admin:hunter2@cache.internal:6379 failed",
  );
  if (code) {
    (err as Error & { cause?: unknown }).cause = { code };
  }
  return err;
}

describe("describeTransportFailure — credential redaction at the sink", () => {
  // Driven from the real label list rather than one example, so a new caller
  // with a new label is covered without editing this test. The labels are the
  // ones the five call sites actually pass.
  const LABELS = ["domain database", "robots.txt", "Crawl4AI"] as const;

  for (const label of LABELS) {
    it(`strips inline credentials for "${label}" (with a transport code)`, () => {
      const out = describeTransportFailure(
        credentialedError("ECONNREFUSED"),
        label,
      );
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("admin:hunter2");
      // Redaction must not eat the diagnosis. A reason that names nothing is
      // as useless as a leak is dangerous.
      expect(out).toContain(label);
      expect(out).toContain("ECONNREFUSED");
      expect(out).toContain("cache.internal");
    });

    it(`strips inline credentials for "${label}" (no transport code)`, () => {
      // The other branch of the ternary. Covering only the coded branch would
      // leave the bare-message path — the one a plain `fetch failed` takes —
      // unasserted.
      const out = describeTransportFailure(credentialedError(), label);
      expect(out).not.toContain("hunter2");
      expect(out).toContain(label);
      expect(out).toContain("cache.internal");
    });
  }

  it("redacts a non-Error thrown value too", () => {
    // String(err) is the other way a message reaches the template.
    const out = describeTransportFailure(
      "amqp://guest:s3cret@broker.internal:5672 refused",
      "queue",
    );
    expect(out).not.toContain("s3cret");
    expect(out).toContain("broker.internal");
  });

  it("leaves a credential-free message byte-identical", () => {
    // The negative control. Without it, a function that mangled every message
    // would pass every assertion above.
    const err = new Error("connect ECONNREFUSED 10.0.0.5:6379");
    (err as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(describeTransportFailure(err, "domain database")).toBe(
      "domain database unreachable: ECONNREFUSED (connect ECONNREFUSED 10.0.0.5:6379)",
    );
  });

  it("is idempotent — a second pass does not corrupt an already-redacted string", () => {
    // resources.ts still redacts at its own sink as defence in depth, so the
    // string goes through twice on that path.
    const once = describeTransportFailure(
      credentialedError("ECONNRESET"),
      "domain database",
    );
    const twice = describeTransportFailure(new Error(once), "domain database");
    expect(twice).toContain("<redacted>");
    expect(twice).not.toContain("hunter2");
  });
});

describe("warnDependencyFailure — the stderr path", () => {
  it("does not print credentials to the log", () => {
    // warnDependencyFailure formats through describeTransportFailure, so it is
    // covered by the sink fix — but it writes to a DIFFERENT sink (PM2's log),
    // and asserting it here is what makes that inheritance a tested fact rather
    // than an assumption about call graphs.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      warnDependencyFailure(credentialedError("ENOTFOUND"), "Kiwix");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]?.join(" ") ?? "";
      expect(line).not.toContain("hunter2");
      expect(line).toContain("ENOTFOUND");
      expect(line).toContain("cache.internal");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("domain_stats tool output — end to end (vikunja#715)", () => {
  it("cannot return a credential in content or structuredContent", async () => {
    // The specific leak #715 names. enumerateDomains is mocked to fail the way
    // a wrong VALKEY_URL password actually fails, and the assertion is made
    // against what the TOOL returns — both the human-readable text and the
    // structured field — not against the helper.
    vi.resetModules();
    // enumerateDomains is mocked, but `unavailable` is produced by the REAL
    // describeTransportFailure. Hand-writing the string here would test a
    // restatement of the format instead of the function under test — and would
    // keep passing if the sink fix were reverted.
    const { describeTransportFailure: describeReal } = await import(
      "../src/transport-failure.js"
    );
    vi.doMock("../src/domain-stats.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/domain-stats.js")
      >("../src/domain-stats.js");
      return {
        ...actual,
        enumerateDomains: async () => ({
          records: [],
          truncated: false,
          staleKeys: [],
          unavailable: describeReal(
            credentialedError("ECONNREFUSED"),
            "domain database",
          ),
        }),
      };
    });

    const { handleDomainStats } = await import("../src/tools.js");
    const r = await handleDomainStats({});

    const whole = JSON.stringify(r);
    expect(whole).not.toContain("hunter2");
    expect(whole).not.toContain("admin:hunter2");

    // And the diagnosis still reaches the operator, which is the whole reason
    // this field exists (vikunja#688) — a redaction that silences the report
    // would trade one invisible failure for another.
    expect(whole).toContain("ECONNREFUSED");
    expect(whole).toContain("cache.internal");
    expect(whole).toContain("not a report that the database is empty");
  });
});
