import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  getValkey: vi.fn(),
  cacheGet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { getValkey } from "../src/cache.js";
import type { DomainRecord, TierStat } from "../src/domain-db.js";
import { aggregateDomainStats, enumerateDomains } from "../src/domain-stats.js";

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
    schema_version: 4,
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

  it("is best-effort: returns empty on a scan error rather than throwing", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("connection reset"));
    getValkeyMock.mockResolvedValue(fakeClient({ scan }));
    await expect(enumerateDomains()).resolves.toEqual({
      records: [],
      truncated: false,
    });
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
