import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { cacheAtomicUpdate, cacheGet } from "../src/cache.js";
import {
  type DomainRecord,
  getDomainRecord,
  normalizeHostname,
  recordLlmsFullProbe,
  recordMetadataFetchAttempt,
  recordPostExtractSample,
  recordRobotsProbe,
  recordSearchAppearance,
  recordTierAttempt,
  shouldSkipJsonLdPostExtract,
} from "../src/domain-db.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheAtomicUpdateMock = vi.mocked(cacheAtomicUpdate);

// Simulate an atomic update: call mutateFn with the current stored value and
// capture the result. Mimics the WATCH/MULTI/EXEC contract in tests.
function setupAtomicMock(initial: string | null = null): {
  getStored: () => string | null;
} {
  let stored: string | null = initial;
  cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
    stored = mutateFn(stored);
  });
  return { getStored: () => stored };
}

function lastWrittenRecord(stored: string | null): DomainRecord {
  if (!stored) throw new Error("No record written");
  return JSON.parse(stored) as DomainRecord;
}

describe("normalizeHostname", () => {
  it("extracts hostname from a URL", () => {
    expect(normalizeHostname("https://docs.anthropic.com/en/x")).toBe(
      "docs.anthropic.com",
    );
  });

  it("strips a leading www.", () => {
    expect(normalizeHostname("https://www.example.com/")).toBe("example.com");
  });

  it("lowercases the result", () => {
    expect(normalizeHostname("https://Docs.ANTHROPIC.com/x")).toBe(
      "docs.anthropic.com",
    );
  });

  it("returns null on input that is neither URL nor hostname", () => {
    expect(normalizeHostname("not a hostname://")).toBeNull();
  });

  it("accepts a bare hostname", () => {
    expect(normalizeHostname("Docs.Anthropic.COM")).toBe("docs.anthropic.com");
  });
});

describe("recordTierAttempt", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates a new record on the first call", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordTierAttempt("https://example.com/p", "tier1_firecrawl", "hit");
    const written = lastWrittenRecord(getStored());
    expect(written.domain).toBe("example.com");
    expect(written.schema_version).toBe(4);
    expect(written.tier_stats_30d.tier1.attempts).toBe(1);
    expect(written.tier_stats_30d.tier1.ok).toBe(1);
    expect(written.tier_stats_30d.tier1.window_start_ms).toBeGreaterThan(0);
  });

  it("updates an existing record incrementally", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: { attempts: 2, ok: 1, fail: 1, window_start_ms: Date.now() },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        github: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    };
    const { getStored } = setupAtomicMock(JSON.stringify(seed));
    await recordTierAttempt(
      "https://example.com/p",
      "tier1_firecrawl",
      "error",
      "timeout",
    );
    const written = lastWrittenRecord(getStored());
    expect(written.tier_stats_30d.tier1.attempts).toBe(3);
    expect(written.tier_stats_30d.tier1.fail).toBe(2);
    expect(written.tier_stats_30d.tier1.last_fail_reason).toBe("timeout");
  });

  it("resets window counters when window_start_ms is older than 30 days", async () => {
    const oldWindowMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-04-01T00:00:00Z",
      last_fetch: "2026-04-15T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: {
          attempts: 50,
          ok: 5,
          fail: 45,
          last_fail_reason: "old_error",
          window_start_ms: oldWindowMs,
        },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        github: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    };
    const { getStored } = setupAtomicMock(JSON.stringify(seed));
    await recordTierAttempt("https://example.com/p", "tier1_firecrawl", "hit");
    const written = lastWrittenRecord(getStored());
    // Old window expired — counters reset, then this one attempt recorded
    expect(written.tier_stats_30d.tier1.attempts).toBe(1);
    expect(written.tier_stats_30d.tier1.ok).toBe(1);
    expect(written.tier_stats_30d.tier1.fail).toBe(0);
    expect(written.tier_stats_30d.tier1.last_fail_reason).toBeUndefined();
    expect(written.tier_stats_30d.tier1.window_start_ms).toBeGreaterThan(
      oldWindowMs,
    );
  });

  it("does not throw on malformed cache content", async () => {
    const { getStored } = setupAtomicMock("{not json");
    await expect(
      recordTierAttempt("https://example.com/p", "tier2_crawl4ai", "hit"),
    ).resolves.toBeUndefined();
    // A fresh record should be created and written.
    expect(cacheAtomicUpdateMock).toHaveBeenCalled();
    expect(getStored()).not.toBeNull();
  });

  it("treats normalized hostnames as the same record", async () => {
    setupAtomicMock(null);
    await recordTierAttempt(
      "https://www.Example.com/p",
      "tier1_firecrawl",
      "hit",
    );
    const key = cacheAtomicUpdateMock.mock.calls[0][0] as string;
    expect(key).toBe("domain:example.com");
  });

  it("serializes concurrent writes for the same hostname (no read-modify-write race)", async () => {
    // Simulate the in-fetch race: tier attempt, robots probe, and post-extract
    // sample all fire concurrently for one URL. With atomic writes the final
    // record must reflect all three updates.
    let stored: string | null = null;
    cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
      stored = mutateFn(stored);
    });

    await Promise.all([
      recordTierAttempt("https://example.com/p", "tier1_firecrawl", "hit"),
      recordRobotsProbe("https://example.com", true, true),
      recordPostExtractSample("https://example.com/p", {
        jsonLdPresent: true,
        ogTitlePresent: true,
      }),
    ]);

    const final = JSON.parse(stored as string) as DomainRecord;
    expect(final.tier_stats_30d.tier1.attempts).toBe(1);
    expect(final.tier_stats_30d.tier1.ok).toBe(1);
    expect(final.capabilities.robots_txt?.present).toBe(true);
    expect(final.capabilities.json_ld_article?.sampled).toBe(1);
    expect(final.capabilities.og_title?.sampled).toBe(1);
  });

  it("records tier4_wayback attempts under tier_stats_30d.tier4", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordTierAttempt("https://example.com/p", "tier4_wayback", "hit");
    const written = lastWrittenRecord(getStored());
    expect(written.tier_stats_30d.tier4.attempts).toBe(1);
    expect(written.tier_stats_30d.tier4.ok).toBe(1);
    expect(written.tier_stats_30d.tier1.attempts).toBe(0);
  });

  it("records github fast-path attempts under tier_stats_30d.github (SXNG-10)", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordTierAttempt(
      "https://raw.githubusercontent.com/a/b/main/f.txt",
      "github",
      "error",
      "404 Not Found",
    );
    const written = lastWrittenRecord(getStored());
    expect(written.tier_stats_30d.github.attempts).toBe(1);
    expect(written.tier_stats_30d.github.fail).toBe(1);
    expect(written.tier_stats_30d.github.last_fail_reason).toBe(
      "404 Not Found",
    );
    // Github traffic must not leak into any cascade tier.
    expect(written.tier_stats_30d.tier1.attempts).toBe(0);
    expect(written.tier_stats_30d.tier3.attempts).toBe(0);
  });

  it("rebuilds a schema-3 record fresh on the 3->4 bump (loses stale windows)", async () => {
    // A pre-bump record carrying accumulated tier1 stats but no github slot.
    const staleSeed = JSON.stringify({
      schema_version: 3,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: { attempts: 40, ok: 2, fail: 38, window_start_ms: Date.now() },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    });
    const { getStored } = setupAtomicMock(staleSeed);
    await recordTierAttempt("https://example.com/p", "github", "hit");
    const written = lastWrittenRecord(getStored());
    expect(written.schema_version).toBe(4);
    // Stale tier1 windows discarded on rebuild, github slot now present.
    expect(written.tier_stats_30d.tier1.attempts).toBe(0);
    expect(written.tier_stats_30d.github.attempts).toBe(1);
    expect(written.tier_stats_30d.github.ok).toBe(1);
  });
});

describe("recordMetadataFetchAttempt", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("creates the metadata_fetch capability on first call", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordMetadataFetchAttempt("https://example.com/p", true);
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.metadata_fetch?.attempts).toBe(1);
    expect(written.capabilities.metadata_fetch?.ok).toBe(1);
    expect(written.capabilities.metadata_fetch?.fail).toBe(0);
  });

  it("accumulates attempts/ok/fail across calls", async () => {
    let stored: string | null = null;
    cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
      stored = mutateFn(stored);
    });
    await recordMetadataFetchAttempt("https://example.com/p", true);
    await recordMetadataFetchAttempt("https://example.com/p", false);
    const final = JSON.parse(stored as string) as DomainRecord;
    expect(final.capabilities.metadata_fetch?.attempts).toBe(2);
    expect(final.capabilities.metadata_fetch?.ok).toBe(1);
    expect(final.capabilities.metadata_fetch?.fail).toBe(1);
  });
});

describe("recordSearchAppearance", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("creates the seen_in_search capability on first call", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordSearchAppearance("https://example.com/p");
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.seen_in_search?.count).toBe(1);
    expect(written.capabilities.seen_in_search?.last_seen_at).toBeDefined();
  });

  it("increments count across repeated appearances", async () => {
    let stored: string | null = null;
    cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
      stored = mutateFn(stored);
    });
    await recordSearchAppearance("https://example.com/a");
    await recordSearchAppearance("https://example.com/b");
    const final = JSON.parse(stored as string) as DomainRecord;
    expect(final.capabilities.seen_in_search?.count).toBe(2);
  });
});

describe("recordLlmsFullProbe", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("sets preferred_strategy to llms_full_txt on a present probe", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordLlmsFullProbe("https://docs.anthropic.com", true, 76_123_708);
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.llms_full_txt?.present).toBe(true);
    expect(written.capabilities.llms_full_txt?.size_bytes).toBe(76_123_708);
    expect(written.preferred_strategy).toBe("llms_full_txt");
  });

  it("records absence without changing preferred_strategy", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordLlmsFullProbe("https://docs.openai.com", false);
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.llms_full_txt?.present).toBe(false);
    expect(written.preferred_strategy).toBeUndefined();
  });
});

describe("recordRobotsProbe", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("records a present, allowed result", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordRobotsProbe("https://example.com", true, true);
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.robots_txt?.present).toBe(true);
    expect(written.capabilities.robots_txt?.allows_us).toBe(true);
  });

  it("records disallow", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordRobotsProbe("https://example.com", true, false);
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.robots_txt?.allows_us).toBe(false);
  });
});

describe("recordPostExtractSample", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("increments sampled and present counters", async () => {
    const { getStored } = setupAtomicMock(null);
    await recordPostExtractSample("https://example.com/page", {
      jsonLdPresent: true,
      ogTitlePresent: true,
    });
    const written = lastWrittenRecord(getStored());
    expect(written.capabilities.json_ld_article?.sampled).toBe(1);
    expect(written.capabilities.json_ld_article?.present).toBe(1);
    expect(written.capabilities.og_title?.sampled).toBe(1);
    expect(written.capabilities.og_title?.present).toBe(1);
  });
});

describe("shouldSkipJsonLdPostExtract", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheAtomicUpdateMock.mockReset();
  });

  it("returns false when no record exists", async () => {
    cacheGetMock.mockResolvedValue(null);
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      false,
    );
  });

  it("returns false until 5 samples are recorded with zero hits", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {
        json_ld_article: {
          sampled: 4,
          present: 0,
          last_sampled_at: "2026-05-15T00:00:00Z",
        },
      },
      tier_stats_30d: {
        tier1: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        github: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      false,
    );
  });

  it("returns true after 5+ samples with zero JSON-LD hits", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {
        json_ld_article: {
          sampled: 7,
          present: 0,
          last_sampled_at: "2026-05-15T00:00:00Z",
        },
      },
      tier_stats_30d: {
        tier1: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        github: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      true,
    );
  });

  it("returns false once any JSON-LD hit has been seen, regardless of sample count", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {
        json_ld_article: {
          sampled: 50,
          present: 1,
          last_sampled_at: "2026-05-15T00:00:00Z",
        },
      },
      tier_stats_30d: {
        tier1: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier2: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier3: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        tier4: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
        github: { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      false,
    );
  });
});

describe("getDomainRecord", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
  });

  it("returns null when no record is cached", async () => {
    cacheGetMock.mockResolvedValue(null);
    expect(await getDomainRecord("https://example.com")).toBeNull();
  });

  it("returns null on stale schema_version", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ schema_version: 0, domain: "example.com" }),
    );
    expect(await getDomainRecord("https://example.com")).toBeNull();
  });

  it("returns null on schema_version 1 (v1 records discarded after v2 bump)", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ schema_version: 1, domain: "example.com" }),
    );
    expect(await getDomainRecord("https://example.com")).toBeNull();
  });

  it("returns null on schema_version 2 (v2 records discarded after v3 tier4 bump)", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ schema_version: 2, domain: "example.com" }),
    );
    expect(await getDomainRecord("https://example.com")).toBeNull();
  });

  it("returns null on schema_version 3 (v3 records discarded after v4 github bump)", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ schema_version: 3, domain: "example.com" }),
    );
    expect(await getDomainRecord("https://example.com")).toBeNull();
  });
});
