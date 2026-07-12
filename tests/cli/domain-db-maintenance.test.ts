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
    schema_version: 4,
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
