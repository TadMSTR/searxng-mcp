import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  getValkey: vi.fn(),
  cacheGet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { getValkey } from "../src/cache.js";
import type { DomainRecord, TierStat } from "../src/domain-db.js";
import { TIER_SLOT_KEYS } from "../src/domain-db.js";
import {
  aggregateDomainStats,
  enumerateDomains,
  formatDomainRecord,
} from "../src/domain-stats.js";

const getValkeyMock = vi.mocked(getValkey);

const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number): TierStat {
  return { attempts, ok, fail, window_start_ms: NOW };
}

function mkRecord(
  domain: string,
  tiers: Partial<DomainRecord["tier_stats_30d"]> = {},
  capabilities: DomainRecord["capabilities"] = {},
): DomainRecord {
  return {
    schema_version: 7,
    domain,
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-06-01T00:00:00Z",
    capabilities,
    tier_stats_30d: {
      tier1: stat(0, 0, 0),
      tier2: stat(0, 0, 0),
      tier3: stat(0, 0, 0),
      tier4: stat(0, 0, 0),
      github: stat(0, 0, 0),
      solver: stat(0, 0, 0),
      crawl: stat(0, 0, 0),
      ...tiers,
    },
  };
}

// Minimal fake iovalkey client — only scan + mget are exercised.
function fakeClient(overrides: {
  scan?: ReturnType<typeof vi.fn>;
  mget?: ReturnType<typeof vi.fn>;
}) {
  return {
    scan: overrides.scan ?? vi.fn(),
    mget: overrides.mget ?? vi.fn(),
  } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>;
}

describe("enumerateDomains", () => {
  beforeEach(() => {
    getValkeyMock.mockReset();
  });

  it("returns parsed records from a single scan page", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["0", ["domain:a.com", "domain:b.com"]]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("a.com")),
        JSON.stringify(mkRecord("b.com")),
      ]);
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));

    const { records, truncated } = await enumerateDomains();
    expect(records.map((r) => r.domain)).toEqual(["a.com", "b.com"]);
    expect(truncated).toBe(false);
    expect(scan).toHaveBeenCalledOnce();
  });

  it("follows the cursor across multiple scan pages", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["7", ["domain:a.com"]])
      .mockResolvedValueOnce(["0", ["domain:b.com"]]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("a.com")),
        JSON.stringify(mkRecord("b.com")),
      ]);
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));

    const { records } = await enumerateDomains();
    expect(records).toHaveLength(2);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("drops stale-schema and malformed entries", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        "0",
        ["domain:a.com", "domain:old.com", "domain:junk.com"],
      ]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("a.com")),
        JSON.stringify({ schema_version: 3, domain: "old.com" }),
        "{not json",
      ]);
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));

    const { records } = await enumerateDomains();
    expect(records.map((r) => r.domain)).toEqual(["a.com"]);
  });

  it("truncates at maxKeys and flags truncated", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        "5",
        ["domain:a.com", "domain:b.com", "domain:c.com"],
      ]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("a.com")),
        JSON.stringify(mkRecord("b.com")),
      ]);
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));

    const { records, truncated } = await enumerateDomains({ maxKeys: 2 });
    expect(truncated).toBe(true);
    expect(records).toHaveLength(2);
    // Stopped after the first page despite a non-zero cursor.
    expect(scan).toHaveBeenCalledOnce();
    expect(mget).toHaveBeenCalledWith(["domain:a.com", "domain:b.com"]);
  });

  it("returns empty without scanning when Valkey is unavailable", async () => {
    getValkeyMock.mockResolvedValue(null);
    const { records, truncated } = await enumerateDomains();
    expect(records).toEqual([]);
    expect(truncated).toBe(false);
  });

  // Retargeted, not removed. The "best-effort" contract still holds — callers
  // are a reporting tool and a scheduled job, and neither is improved by an
  // exception. What this used to assert as well, via toEqual on the whole
  // object, was that a scan error is INDISTINGUISHABLE from an empty corpus.
  // That was the defect (vikunja#688), pinned as an invariant.
  it("is best-effort: does not throw on a scan error, but says it failed", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("connection reset"));
    getValkeyMock.mockResolvedValue(fakeClient({ scan }));
    const result = await enumerateDomains();
    expect(result.records).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.unavailable).toContain("connection reset");
  });

  it("returns empty (no mget) when the scan yields no keys", async () => {
    const scan = vi.fn().mockResolvedValueOnce(["0", []]);
    const mget = vi.fn();
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));
    const { records } = await enumerateDomains();
    expect(records).toEqual([]);
    expect(mget).not.toHaveBeenCalled();
  });
});

describe("aggregateDomainStats — 30d window cutoff", () => {
  const EXPIRED = NOW - 31 * 24 * 60 * 60 * 1000;
  const expired = (attempts: number, ok: number, fail: number): TierStat => ({
    attempts,
    ok,
    fail,
    window_start_ms: EXPIRED,
  });

  it("excludes out-of-window attempts from tier totals", () => {
    const agg = aggregateDomainStats(
      [
        mkRecord("fresh.com", { tier1: stat(10, 8, 2) }),
        mkRecord("stale.com", { tier1: expired(40, 1, 39) }),
      ],
      false,
      NOW,
    );
    // Only fresh.com's numbers survive; stale.com's 40 attempts are outside the
    // window the field claims to report.
    expect(agg.tiers.tier1.attempts).toBe(10);
    expect(agg.tiers.tier1.ok).toBe(8);
    expect(agg.tiers.tier1.success_rate).toBe(0.8);
  });

  it("drops stale domains from top_failing", () => {
    // The reported symptom: grep.app's 0/10 was 26 days old and still driving
    // the failing-domains list.
    const agg = aggregateDomainStats(
      [mkRecord("grep.app", { tier1: expired(10, 0, 10) })],
      false,
      NOW,
    );
    expect(agg.failing_count).toBe(0);
    expect(agg.top_failing).toEqual([]);
  });

  it("still reports a domain failing inside the window", () => {
    // Control: same counts, current window.
    const agg = aggregateDomainStats(
      [mkRecord("grep.app", { tier1: stat(10, 0, 10) })],
      false,
      NOW,
    );
    expect(agg.failing_count).toBe(1);
    expect(agg.top_failing[0]).toMatchObject({
      domain: "grep.app",
      attempts: 10,
      ok: 0,
    });
  });

  it("counts a domain with only expired stats as seen-never-fetched", () => {
    // Once the window drops its attempts the domain genuinely has no fetch
    // record in the reporting period, and must be classified as such rather
    // than silently vanishing from both buckets.
    const agg = aggregateDomainStats(
      [
        mkRecord(
          "idle.com",
          { tier1: expired(10, 5, 5) },
          {
            seen_in_search: { count: 3, last_seen_at: "2026-06-01T00:00:00Z" },
          },
        ),
      ],
      false,
      NOW,
    );
    expect(agg.seen_never_fetched).toBe(1);
    expect(agg.failing_count).toBe(0);
  });
});

describe("aggregateDomainStats", () => {
  it("sums per-tier attempts/ok/fail across domains and computes success rate", async () => {
    const records = [
      mkRecord("a.com", { tier1: stat(10, 9, 1), github: stat(4, 3, 1) }),
      mkRecord("b.com", { tier1: stat(10, 1, 9) }),
    ];
    const agg = aggregateDomainStats(records);
    expect(agg.tiers.tier1).toEqual({
      attempts: 20,
      ok: 10,
      fail: 10,
      success_rate: 0.5,
    });
    expect(agg.tiers.github).toEqual({
      attempts: 4,
      ok: 3,
      fail: 1,
      success_rate: 0.75,
    });
    expect(agg.domains_tracked).toBe(2);
  });

  it("reports success_rate null for a slot with no attempts", () => {
    const agg = aggregateDomainStats([mkRecord("a.com")]);
    expect(agg.tiers.tier2.success_rate).toBeNull();
    expect(agg.tiers.tier4.success_rate).toBeNull();
  });

  it("counts domains seen in search but never fetched", () => {
    const records = [
      // seen, zero attempts → counted
      mkRecord(
        "seen.com",
        {},
        { seen_in_search: { count: 3, last_seen_at: "x" } },
      ),
      // fetched → not counted even though also seen
      mkRecord(
        "fetched.com",
        { tier1: stat(2, 2, 0) },
        { seen_in_search: { count: 1, last_seen_at: "x" } },
      ),
      // never seen, never fetched → not counted
      mkRecord("cold.com"),
    ];
    const agg = aggregateDomainStats(records);
    expect(agg.seen_never_fetched).toBe(1);
  });

  it("lists failing domains worst-first, applying attempt and rate thresholds", () => {
    const records = [
      // 28 attempts, 0 ok → failing, most attempts
      mkRecord("raw.githubusercontent.com", { github: stat(28, 0, 28) }),
      // 10 attempts, 2 ok (20%) → failing
      mkRecord("flaky.com", { tier1: stat(10, 2, 8) }),
      // 10 attempts, 6 ok (60%) → above rate threshold, excluded
      mkRecord("ok.com", { tier1: stat(10, 6, 4) }),
      // 3 attempts, 0 ok → below attempt threshold, excluded
      mkRecord("new.com", { tier1: stat(3, 0, 3) }),
    ];
    const agg = aggregateDomainStats(records);
    expect(agg.failing_count).toBe(2);
    expect(agg.top_failing.map((f) => f.domain)).toEqual([
      "raw.githubusercontent.com",
      "flaky.com",
    ]);
    expect(agg.top_failing[0]).toEqual({
      domain: "raw.githubusercontent.com",
      attempts: 28,
      ok: 0,
      success_rate: 0,
    });
  });

  it("caps the failing list at ten entries", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      mkRecord(`fail${i}.com`, { tier1: stat(20, 0, 20) }),
    );
    const agg = aggregateDomainStats(records);
    expect(agg.failing_count).toBe(15);
    expect(agg.top_failing).toHaveLength(10);
  });

  it("passes the truncated flag through", () => {
    expect(aggregateDomainStats([], true).truncated).toBe(true);
    expect(aggregateDomainStats([]).truncated).toBe(false);
  });
});

// formatDomainRecord had no coverage at all, which is how it came to be a
// hand-written roster of a closed set that TIER_SLOT_KEYS is supposed to own.
// A slot added to the record but missed here records forever and never renders
// in single-domain mode — the exact invisibility the `crawl` slot was added to
// remove. Pinned generically so the next slot fails here until it is rendered,
// rather than being discovered by an operator who cannot find their numbers.
describe("formatDomainRecord renders every tier slot", () => {
  /** The tier-stats rows, in order, from a formatted record. */
  function tierBlock(record: DomainRecord): string[] {
    const lines = formatDomainRecord(record, NOW).split("\n");
    const start = lines.findIndex((l) => l.includes("tier stats (30d window)"));
    expect(start).toBeGreaterThanOrEqual(0);
    return lines.slice(start + 1, start + 1 + TIER_SLOT_KEYS.length);
  }

  it.each(TIER_SLOT_KEYS)("renders the %s slot's own numbers", (slot) => {
    const block = tierBlock(mkRecord("example.com", { [slot]: stat(7, 3, 4) }));
    // 3/7 is unique to the slot under test — every other slot is 0/0 ("no
    // data") — so this cannot be satisfied by a neighbouring row.
    const carrying = block.filter((l) => l.includes("(3/7)"));
    expect(carrying).toHaveLength(1);
    // Matched on the row's leading label rather than `includes(slot)`: every
    // label contains "firecrawl", and "crawl" is a substring of both that and
    // "crawl4ai", so a containment check passes against the wrong row.
    expect(carrying[0].trim().startsWith(slot)).toBe(true);
  });

  it("renders the slots in roster order, one row each", () => {
    const block = tierBlock(mkRecord("example.com"));
    expect(block).toHaveLength(TIER_SLOT_KEYS.length);
    TIER_SLOT_KEYS.forEach((slot, i) => {
      expect(block[i].trim().startsWith(slot)).toBe(true);
    });
  });
});

// vikunja#688 sub-finding, and the more serious consequence of it.
//
// `enumerateDomains` caught every failure and returned `{records: [], truncated}`
// — the exact shape of a healthy scan over an empty corpus. Two things then
// read that as fact:
//
//   1. `domain_stats` reported "domains tracked: 0"
//   2. `domain-db-maintenance` wrote a snapshot containing zero records, made
//      it the NEWEST snapshot, and pruned by retention
//
// (2) is the one that does damage. `loadLatestSnapshot` returns the newest, so
// a single maintenance run during a Valkey outage leaves `restore-domain-db`
// restoring nothing; fourteen consecutive ones (the default retention) prune
// every good snapshot away. A transport failure silently destroys the restore
// path, and the artefact it leaves behind is indistinguishable from a
// legitimate backup of an empty database.
describe("enumerateDomains reports unreachability rather than emptiness", () => {
  beforeEach(() => {
    getValkeyMock.mockReset();
  });

  it("flags a scan that failed mid-flight instead of returning an empty corpus", async () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const scan = vi.fn().mockRejectedValue(err);
    getValkeyMock.mockResolvedValue(fakeClient({ scan }));

    const result = await enumerateDomains();
    expect(result.records).toEqual([]);
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable).toContain("ECONNREFUSED");
  });

  it("distinguishes a genuinely empty corpus from an unreachable one", async () => {
    const scan = vi.fn().mockResolvedValueOnce(["0", []]);
    getValkeyMock.mockResolvedValue(fakeClient({ scan }));

    const result = await enumerateDomains();
    expect(result.records).toEqual([]);
    expect(result.unavailable).toBeUndefined();
  });

  it("flags a domain database that is not configured at all", async () => {
    getValkeyMock.mockResolvedValue(null);

    const result = await enumerateDomains();
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable).toMatch(/not configured/i);
  });
});

/**
 * vikunja#688 — collecting the stale-schema keys the reaper deletes.
 *
 * Measured on the live corpus 2026-09-06 (the ticket's numbers, which research
 * could not independently confirm, re-measured through the configured
 * VALKEY_URL): 1,295 keys, of which 1,196 (92.4%) carry a superseded schema —
 * 122 at schema 2, 475 at 4, 436 at 5, 163 at 6 — against 99 current.
 *
 * The distinction that matters here is stale vs corrupt. A record we
 * deliberately superseded is safe to delete; a record we cannot read is a
 * different decision and is left alone.
 */
describe("enumerateDomains collects stale-schema keys for reaping", () => {
  beforeEach(() => {
    getValkeyMock.mockReset();
  });

  function withRaws(keys: string[], raws: (string | null)[]) {
    const scan = vi.fn().mockResolvedValueOnce(["0", keys]);
    const mget = vi.fn().mockResolvedValueOnce(raws);
    getValkeyMock.mockResolvedValue(fakeClient({ scan, mget }));
  }

  it("lists superseded records and keeps current ones out of the list", async () => {
    const current = mkRecord("current.com");
    const stale = { ...mkRecord("stale.com"), schema_version: 2 };
    withRaws(
      ["domain:current.com", "domain:stale.com"],
      [JSON.stringify(current), JSON.stringify(stale)],
    );

    const r = await enumerateDomains();

    expect(r.records.map((x) => x.domain)).toEqual(["current.com"]);
    expect(r.staleKeys).toEqual(["domain:stale.com"]);
    // The assertion that matters: a live key must never reach the delete list.
    expect(r.staleKeys).not.toContain("domain:current.com");
  });

  it("does not mark an unreadable record as stale", async () => {
    // Corrupt is not superseded. Deleting data we cannot read is a different
    // decision from deleting data we replaced, and this reaper does not make
    // it.
    withRaws(["domain:corrupt.com"], ["{ this is not json"]);

    const r = await enumerateDomains();

    expect(r.records).toEqual([]);
    expect(r.staleKeys).toEqual([]);
  });

  it("returns no delete list when the corpus could not be read", async () => {
    const scan = vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    );
    getValkeyMock.mockResolvedValue(fakeClient({ scan }));

    const r = await enumerateDomains();

    expect(r.unavailable).toBeDefined();
    expect(r.staleKeys).toEqual([]);
  });
});
