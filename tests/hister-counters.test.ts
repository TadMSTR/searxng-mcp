// Hister's own metric accounting.
//
// histerFetch owns the counter on BOTH outcomes, and fetch.ts deliberately counts
// neither. That split is the invariant these tests protect, and it is worth
// protecting because getting it wrong is invisible: counting the hit in both
// places inflated it by exactly 2x, with no error, no test failure, and a metric
// that looked plausible. On a build whose entire subject is telemetry that
// misreports reality, that is the defect to guard against rather than the one to
// fix quietly (CodeRabbit, PR #65).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  HISTER_URL: "http://hister.internal:8123",
  HISTER_TOKEN: "hister-test-token",
}));

const incCounter = vi.fn();
vi.mock("../src/observability.js", () => ({
  incCounter: (...args: unknown[]) => incCounter(...args),
  recordHistogram: vi.fn(),
  withSpan: vi.fn((_n: string, _a: unknown, fn: () => unknown) => fn()),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  _resetHisterWarnThrottleForTests,
  histerFetch,
} from "../src/hister.js";

beforeEach(() => {
  vi.clearAllMocks();
  _resetHisterWarnThrottleForTests();
});

const URL = "https://docs.example.com/guide";
const PREAMBLE = "SECURITY NOTICE: untrusted source data.\n";

function payload(entries: unknown[], schemaVersion = "1.0") {
  return (
    PREAMBLE +
    JSON.stringify({
      schema_version: schemaVersion,
      untrusted_content: entries,
    })
  );
}

function ok(text: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({ result: { content: [{ type: "text", text }] } }),
  };
}

const entry = (url: string) => ({
  fields: { url, title: "T", text: "B", added_unix: 1, updated_unix: 1 },
});

const histerCalls = () =>
  incCounter.mock.calls.filter(
    (c) => (c[1] as { tier?: string } | undefined)?.tier === "hister",
  );

describe("hister metric accounting", () => {
  it("counts a hit EXACTLY ONCE", async () => {
    mockFetch.mockResolvedValueOnce(ok(payload([entry(URL)])));
    expect(await histerFetch(URL)).not.toBeNull();

    const hits = histerCalls().filter(
      (c) => (c[1] as { outcome?: string }).outcome === "hit",
    );
    // Not toHaveBeenCalled() — that passes at 1 and at 2 alike, which is exactly
    // how the double count survived.
    expect(hits).toHaveLength(1);
    expect(histerCalls()).toHaveLength(1);
  });

  it("counts a miss exactly once, and carries the reason", async () => {
    mockFetch.mockResolvedValueOnce(ok(payload([])));
    expect(await histerFetch(URL)).toBeNull();

    const calls = histerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      tier: "hister",
      outcome: "miss",
      reason: "not-indexed",
    });
  });

  it("never records both a hit and a miss for one lookup", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(payload([entry("https://other.example/x")])),
    );
    expect(await histerFetch(URL)).toBeNull();

    const outcomes = histerCalls().map(
      (c) => (c[1] as { outcome?: string }).outcome,
    );
    expect(outcomes).toEqual(["miss"]);
  });

  it("puts the HTTP status on the counter, not only in the stderr detail", async () => {
    // CR-01. A 403 (wrong/absent bearer) and a 502 (Hister down) both record
    // reason=http-error; without the status attribute they are the same point on
    // the metric, and stderr is not what you query when a tier stops serving.
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [403, 502]) {
      incCounter.mockClear();
      mockFetch.mockResolvedValueOnce({ ok: false, status });
      expect(await histerFetch(URL)).toBeNull();
      const calls = histerCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1], `status ${status}`).toMatchObject({
        outcome: "miss",
        reason: "http-error",
        status,
      });
    }
  });

  it("gives each distinct failure its own reason rather than one generic miss", async () => {
    const cases: Array<[unknown, string]> = [
      [ok(payload([entry(URL)], "9.9")), "schema-mismatch"],
      [ok(`${PREAMBLE}{broken`), "unparseable"],
      [ok(payload([entry("https://other.example/x")])), "url-mismatch"],
      [{ ok: false, status: 403 }, "http-error"],
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const [response, expected] of cases) {
      incCounter.mockClear();
      mockFetch.mockResolvedValueOnce(response);
      await histerFetch(URL);
      const calls = histerCalls();
      expect(calls, `response for ${expected}`).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ outcome: "miss", reason: expected });
    }
  });
});
