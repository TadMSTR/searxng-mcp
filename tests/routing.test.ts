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
import { computeTierSkips } from "../src/routing.js";

const cacheGetMock = vi.mocked(cacheGet);
const getOpSkipMock = vi.mocked(getOperatorTierSkips);

function record(overrides: Partial<DomainRecord>): DomainRecord {
  return {
    schema_version: 1,
    domain: "example.com",
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-05-01T00:00:00Z",
    capabilities: {},
    tier_stats_30d: {
      tier1: { attempts: 0, ok: 0, fail: 0 },
      tier2: { attempts: 0, ok: 0, fail: 0 },
      tier3: { attempts: 0, ok: 0, fail: 0 },
    },
    ...overrides,
  };
}

describe("computeTierSkips", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    getOpSkipMock.mockReset();
    getOpSkipMock.mockReturnValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns no skips during cold start (under 10 attempts)", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 5, ok: 0, fail: 5 },
            tier2: { attempts: 0, ok: 0, fail: 0 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    const skips = await computeTierSkips("https://example.com/p");
    expect(skips).toEqual([]);
  });

  it("skips tier1 when success rate < 30% over >=10 attempts", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 20, ok: 4, fail: 16 },
            tier2: { attempts: 0, ok: 0, fail: 0 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    const skips = await computeTierSkips("https://example.com/p");
    expect(skips).toEqual([{ tier: "tier1", reason: "low_success_rate" }]);
  });

  it("does not skip when success rate is at or above 30%", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 20, ok: 6, fail: 14 },
            tier2: { attempts: 0, ok: 0, fail: 0 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    const skips = await computeTierSkips("https://example.com/p");
    expect(skips).toEqual([]);
  });

  it("can skip multiple tiers in one pass", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 50, ok: 1, fail: 49 },
            tier2: { attempts: 50, ok: 5, fail: 45 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    const skips = await computeTierSkips("https://example.com/p");
    const slots = new Set(skips.map((s) => s.tier));
    expect(slots.has("tier1")).toBe(true);
    expect(slots.has("tier2")).toBe(true);
    expect(slots.has("tier3")).toBe(false);
  });

  it("operator override skips tier even without any stats", async () => {
    cacheGetMock.mockResolvedValue(null);
    getOpSkipMock.mockReturnValue(["tier1"]);
    const skips = await computeTierSkips("https://example.com/p");
    expect(skips).toEqual([{ tier: "tier1", reason: "operator_override" }]);
  });

  it("operator override wins over a stats-based skip for the same tier", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 20, ok: 1, fail: 19 },
            tier2: { attempts: 0, ok: 0, fail: 0 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    getOpSkipMock.mockReturnValue(["tier1"]);
    const skips = await computeTierSkips("https://example.com/p");
    expect(skips).toEqual([{ tier: "tier1", reason: "operator_override" }]);
  });

  it("combines operator override on one tier with stats-based skip on another", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier1: { attempts: 20, ok: 1, fail: 19 },
            tier2: { attempts: 0, ok: 0, fail: 0 },
            tier3: { attempts: 0, ok: 0, fail: 0 },
          },
        }),
      ),
    );
    getOpSkipMock.mockReturnValue(["tier2"]);
    const skips = await computeTierSkips("https://example.com/p");
    const byTier = new Map(skips.map((s) => [s.tier, s.reason]));
    expect(byTier.get("tier1")).toBe("low_success_rate");
    expect(byTier.get("tier2")).toBe("operator_override");
  });

  it("returns no skips when no record exists and no operator overrides", async () => {
    cacheGetMock.mockResolvedValue(null);
    expect(await computeTierSkips("https://example.com/p")).toEqual([]);
  });
});
