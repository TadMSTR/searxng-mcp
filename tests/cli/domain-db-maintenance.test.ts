import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cache.js", () => ({
  getValkey: vi.fn(),
  cacheGet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { getValkey } from "../../src/cache.js";
import {
  deriveGauges,
  emitGauges,
  runMaintenance,
} from "../../src/cli/domain-db-maintenance.js";
import { loadLatestSnapshot } from "../../src/domain-snapshot.js";
import type { DomainAggregate } from "../../src/domain-stats.js";

const getValkeyMock = vi.mocked(getValkey);
const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: NOW };
}

function recordJson(
  domain: string,
  tiers: Record<string, ReturnType<typeof stat>> = {},
) {
  return JSON.stringify({
    schema_version: 7,
    domain,
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-06-01T00:00:00Z",
    capabilities: {},
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
  });
}

function tierAgg(attempts: number, ok: number, rate: number | null) {
  return { attempts, ok, fail: attempts - ok, success_rate: rate };
}

describe("deriveGauges", () => {
  it("maps tracked/failing counts and emits only tiers with data", () => {
    const agg: DomainAggregate = {
      domains_tracked: 12,
      seen_never_fetched: 3,
      failing_count: 4,
      top_failing: [],
      truncated: false,
      tiers: {
        tier1: tierAgg(10, 9, 0.9),
        tier2: tierAgg(0, 0, null),
        tier3: tierAgg(4, 1, 0.25),
        tier4: tierAgg(0, 0, null),
        github: tierAgg(28, 0, 0),
        solver: tierAgg(2, 1, 0.5),
        crawl: tierAgg(2, 1, 0.5),
      },
    };
    const g = deriveGauges(agg);
    expect(g.domains_tracked).toBe(12);
    expect(g.domains_failing).toBe(4);
    // tier2/tier4 (null ratio) are omitted; the rest are present.
    expect(g.tier_success_ratio).toEqual([
      { tier: "tier1", ratio: 0.9 },
      { tier: "tier3", ratio: 0.25 },
      { tier: "github", ratio: 0 },
      { tier: "solver", ratio: 0.5 },
      { tier: "crawl", ratio: 0.5 },
    ]);
  });
});

describe("emitGauges", () => {
  it("no-ops (returns false) when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const ok = await emitGauges({
      domains_tracked: 1,
      domains_failing: 0,
      tier_success_ratio: [],
    });
    expect(ok).toBe(false);
    if (prev !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
  });
});

describe("runMaintenance", () => {
  let dir: string;
  let prevEndpoint: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "maint-"));
    getValkeyMock.mockReset();
    // Force the gauge path to no-op deterministically.
    prevEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (prevEndpoint !== undefined) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevEndpoint;
    }
  });

  it("scans, writes a snapshot, and reports aggregate counts", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        "0",
        ["domain:good.com", "domain:raw.githubusercontent.com"],
      ]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        recordJson("good.com", { tier1: stat(10, 9, 1) }),
        recordJson("raw.githubusercontent.com", { github: stat(28, 0, 28) }),
      ]);
    getValkeyMock.mockResolvedValue({ scan, mget } as unknown as NonNullable<
      Awaited<ReturnType<typeof getValkey>>
    >);

    const r = await runMaintenance({ snapshotDir: dir });
    expect(r.count).toBe(2);
    expect(r.gaugesEmitted).toBe(false);
    expect(r.aggregate.domains_tracked).toBe(2);
    expect(r.aggregate.failing_count).toBe(1);

    // Snapshot actually landed on disk and round-trips.
    const loaded = await loadLatestSnapshot(dir);
    expect(loaded?.count).toBe(2);
    expect(loaded?.records.map((x) => x.domain).sort()).toEqual([
      "good.com",
      "raw.githubusercontent.com",
    ]);
  });

  it("writes an empty snapshot when the domain-db is empty", async () => {
    const scan = vi.fn().mockResolvedValueOnce(["0", []]);
    getValkeyMock.mockResolvedValue({
      scan,
      mget: vi.fn(),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const r = await runMaintenance({ snapshotDir: dir });
    expect(r.count).toBe(0);
    expect(r.aggregate.domains_tracked).toBe(0);
    const loaded = await loadLatestSnapshot(dir);
    expect(loaded?.count).toBe(0);
  });
});

// vikunja#688. The reporting half of this ticket ("domains tracked: 0") is
// cosmetic. This half is not: the maintenance job wrote whatever
// enumerateDomains returned, and a failed scan returned an empty array. That
// made an empty file the NEWEST snapshot — the one loadLatestSnapshot returns
// and restore-domain-db restores from — while pruneSnapshots aged out a real
// one. At the default retention of 14, fourteen consecutive failed runs leave
// nothing but empty snapshots, each indistinguishable from a genuine backup of
// an empty database.
//
// The assertion that matters is the third one: a pre-existing good snapshot is
// still the newest after a failed run.
describe("runMaintenance refuses to snapshot a corpus it could not read", () => {
  let dir: string;

  beforeEach(async () => {
    getValkeyMock.mockReset();
    dir = await mkdtemp(join(tmpdir(), "dbm-unavailable-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runWithScan(scan: ReturnType<typeof vi.fn>) {
    getValkeyMock.mockResolvedValue({
      scan,
      mget: vi.fn(),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);
    return runMaintenance({ snapshotDir: dir, retention: 14 });
  }

  it("writes nothing and reports why when the scan fails", async () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const r = await runWithScan(vi.fn().mockRejectedValue(err));

    expect(r.skipped).toBeDefined();
    expect(r.skipped).toContain("ECONNREFUSED");
    expect(r.snapshotPath).toBe("");
    expect(r.pruned).toBe(0);
    expect(r.gaugesEmitted).toBe(false);
    expect(await loadLatestSnapshot(dir)).toBeNull();
  });

  it("does not overwrite the newest good snapshot with an empty one", async () => {
    // A healthy run first.
    const good = await runWithScan(
      vi.fn().mockResolvedValueOnce(["0", ["domain:a.com", "domain:b.com"]]),
    );
    getValkeyMock.mockResolvedValue({
      scan: vi
        .fn()
        .mockResolvedValueOnce(["0", ["domain:a.com", "domain:b.com"]]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([recordJson("a.com"), recordJson("b.com")]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);
    await runMaintenance({ snapshotDir: dir, retention: 14 });
    const before = await loadLatestSnapshot(dir);
    expect(before?.records.length).toBeGreaterThan(0);
    void good;

    // Now Valkey goes away.
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const r = await runWithScan(vi.fn().mockRejectedValue(err));
    expect(r.skipped).toBeDefined();

    // The restore point must be untouched — this is the whole point.
    const after = await loadLatestSnapshot(dir);
    expect(after?.records.map((x) => x.domain)).toEqual(
      before?.records.map((x) => x.domain),
    );
    expect(after?.count).toBe(before?.count);
  });

  it("still snapshots a genuinely empty corpus", async () => {
    // The negative control: empty is a real state and must still be recorded,
    // or this fix would just be a different way of losing data.
    const r = await runWithScan(vi.fn().mockResolvedValueOnce(["0", []]));
    expect(r.skipped).toBeUndefined();
    expect(r.snapshotPath).not.toBe("");
    expect((await loadLatestSnapshot(dir))?.count).toBe(0);
  });
});
