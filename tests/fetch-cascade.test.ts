// Tests for the Phase-2 tier cascade refactor: Tier interface, getTiers(),
// and ALL_TIERS ordering. These tests complement the routing.test.ts suite
// (which covers computeTierSkips) by verifying the Tier objects and the
// getTiers helper that wires skips into an active tier list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/domains.js", () => ({
  getOperatorTierSkips: vi.fn(() => []),
}));

import { cacheGet } from "../src/cache.js";
import type { DomainRecord } from "../src/domain-db.js";
import { getOperatorTierSkips } from "../src/domains.js";
import { getTiers } from "../src/routing.js";
import { ALL_TIERS, tier1, tier2, tier3 } from "../src/tiers/index.js";

const cacheGetMock = vi.mocked(cacheGet);
const getOpSkipMock = vi.mocked(getOperatorTierSkips);

const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: NOW };
}

function record(overrides: Partial<DomainRecord>): DomainRecord {
  return {
    schema_version: 2,
    domain: "example.com",
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-05-01T00:00:00Z",
    capabilities: {},
    tier_stats_30d: {
      tier1: stat(0, 0, 0),
      tier2: stat(0, 0, 0),
      tier3: stat(0, 0, 0),
    },
    ...overrides,
  };
}

describe("Tier objects", () => {
  it("tier1 has name=tier1_firecrawl and slot=tier1", () => {
    expect(tier1.name).toBe("tier1_firecrawl");
    expect(tier1.slot).toBe("tier1");
  });

  it("tier2 has name=tier2_crawl4ai and slot=tier2", () => {
    expect(tier2.name).toBe("tier2_crawl4ai");
    expect(tier2.slot).toBe("tier2");
  });

  it("tier3 has name=tier3_rawfetch and slot=tier3", () => {
    expect(tier3.name).toBe("tier3_rawfetch");
    expect(tier3.slot).toBe("tier3");
  });

  it("ALL_TIERS contains tier1, tier2, tier3 in priority order", () => {
    expect(ALL_TIERS).toHaveLength(3);
    expect(ALL_TIERS[0]).toBe(tier1);
    expect(ALL_TIERS[1]).toBe(tier2);
    expect(ALL_TIERS[2]).toBe(tier3);
  });

  it("each Tier has a fetch function", () => {
    for (const tier of ALL_TIERS) {
      expect(typeof tier.fetch).toBe("function");
    }
  });
});

describe("getTiers — active tier list", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    getOpSkipMock.mockReset();
    getOpSkipMock.mockReturnValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns all three tiers when no skips apply", async () => {
    cacheGetMock.mockResolvedValue(null);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active).toHaveLength(3);
    expect(active.map((t) => t.slot)).toEqual(["tier1", "tier2", "tier3"]);
    expect(skipped).toHaveLength(0);
  });

  it("excludes tier1 when success rate < 30% over >=10 attempts", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: stat(20, 4, 16), // 20% success rate
            tier2: stat(0, 0, 0),
            tier3: stat(0, 0, 0),
          },
        }),
      ),
    );
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier2", "tier3"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({ tier: "tier1", reason: "low_success_rate" });
  });

  it("excludes operator-override tiers from the active list", async () => {
    cacheGetMock.mockResolvedValue(null);
    getOpSkipMock.mockReturnValue(["tier1", "tier3"]);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier2"]);
    expect(skipped.map((s) => s.tier)).toEqual(
      expect.arrayContaining(["tier1", "tier3"]),
    );
  });

  it("returns empty active list when all tiers are skipped", async () => {
    cacheGetMock.mockResolvedValue(null);
    getOpSkipMock.mockReturnValue(["tier1", "tier2", "tier3"]);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active).toHaveLength(0);
    expect(skipped).toHaveLength(3);
  });

  it("preserves tier order in active list after partial skip", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: stat(0, 0, 0),
            tier2: stat(20, 2, 18), // 10% success rate → skip
            tier3: stat(0, 0, 0),
          },
        }),
      ),
    );
    const { active } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier1", "tier3"]);
  });

  it("skipped list carries both low_success_rate and operator_override reasons", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: stat(20, 1, 19), // low success → skip
            tier2: stat(0, 0, 0),
            tier3: stat(0, 0, 0),
          },
        }),
      ),
    );
    getOpSkipMock.mockReturnValue(["tier3"]); // operator override
    const { skipped } = await getTiers("https://example.com/p");
    const byTier = new Map(skipped.map((s) => [s.tier, s.reason]));
    expect(byTier.get("tier1")).toBe("low_success_rate");
    expect(byTier.get("tier3")).toBe("operator_override");
  });
});
