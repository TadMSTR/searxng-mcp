import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import {
  _clearWriteLocksForTests,
  type DomainRecord,
  getDomainRecord,
  normalizeHostname,
  recordLlmsFullProbe,
  recordPostExtractSample,
  recordRobotsProbe,
  recordTierAttempt,
  shouldSkipJsonLdPostExtract,
} from "../src/domain-db.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);

function lastWrittenRecord(): DomainRecord {
  const lastCall = cacheSetMock.mock.calls[cacheSetMock.mock.calls.length - 1];
  return JSON.parse(lastCall[1] as string) as DomainRecord;
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
    cacheSetMock.mockReset();
    _clearWriteLocksForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates a new record on the first call", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordTierAttempt("https://example.com/p", "tier1_firecrawl", "hit");
    const written = lastWrittenRecord();
    expect(written.domain).toBe("example.com");
    expect(written.schema_version).toBe(1);
    expect(written.tier_stats_30d.tier1.attempts).toBe(1);
    expect(written.tier_stats_30d.tier1.ok).toBe(1);
  });

  it("updates an existing record incrementally", async () => {
    const seed: DomainRecord = {
      schema_version: 1,
      domain: "example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-05-01T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: { attempts: 2, ok: 1, fail: 1 },
        tier2: { attempts: 0, ok: 0, fail: 0 },
        tier3: { attempts: 0, ok: 0, fail: 0 },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    await recordTierAttempt(
      "https://example.com/p",
      "tier1_firecrawl",
      "error",
      "timeout",
    );
    const written = lastWrittenRecord();
    expect(written.tier_stats_30d.tier1.attempts).toBe(3);
    expect(written.tier_stats_30d.tier1.fail).toBe(2);
    expect(written.tier_stats_30d.tier1.last_fail_reason).toBe("timeout");
  });

  it("does not throw on malformed cache content", async () => {
    cacheGetMock.mockResolvedValue("{not json");
    await expect(
      recordTierAttempt("https://example.com/p", "tier2_crawl4ai", "hit"),
    ).resolves.toBeUndefined();
    // A fresh record should be created and written.
    expect(cacheSetMock).toHaveBeenCalled();
  });

  it("treats normalized hostnames as the same record", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordTierAttempt(
      "https://www.Example.com/p",
      "tier1_firecrawl",
      "hit",
    );
    const key = cacheSetMock.mock.calls[0][0] as string;
    expect(key).toBe("domain:example.com");
  });

  it("serializes concurrent writes for the same hostname (no read-modify-write race)", async () => {
    // Simulate the in-fetch race: tier attempt, robots probe, and post-extract
    // sample all fire concurrently for one URL. With proper serialization the
    // final record reflects all three updates.
    let stored: string | null = null;
    cacheGetMock.mockImplementation(async () => stored);
    cacheSetMock.mockImplementation(async (_k, v) => {
      stored = v as string;
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
});

describe("recordLlmsFullProbe", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    _clearWriteLocksForTests();
  });

  it("sets preferred_strategy to llms_full_txt on a present probe", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordLlmsFullProbe("https://docs.anthropic.com", true, 76_123_708);
    const written = lastWrittenRecord();
    expect(written.capabilities.llms_full_txt?.present).toBe(true);
    expect(written.capabilities.llms_full_txt?.size_bytes).toBe(76_123_708);
    expect(written.preferred_strategy).toBe("llms_full_txt");
  });

  it("records absence without changing preferred_strategy", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordLlmsFullProbe("https://docs.openai.com", false);
    const written = lastWrittenRecord();
    expect(written.capabilities.llms_full_txt?.present).toBe(false);
    expect(written.preferred_strategy).toBeUndefined();
  });
});

describe("recordRobotsProbe", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    _clearWriteLocksForTests();
  });

  it("records a present, allowed result", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordRobotsProbe("https://example.com", true, true);
    const written = lastWrittenRecord();
    expect(written.capabilities.robots_txt?.present).toBe(true);
    expect(written.capabilities.robots_txt?.allows_us).toBe(true);
  });

  it("records disallow", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordRobotsProbe("https://example.com", true, false);
    const written = lastWrittenRecord();
    expect(written.capabilities.robots_txt?.allows_us).toBe(false);
  });
});

describe("recordPostExtractSample", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    _clearWriteLocksForTests();
  });

  it("increments sampled and present counters", async () => {
    cacheGetMock.mockResolvedValue(null);
    await recordPostExtractSample("https://example.com/page", {
      jsonLdPresent: true,
      ogTitlePresent: true,
    });
    const written = lastWrittenRecord();
    expect(written.capabilities.json_ld_article?.sampled).toBe(1);
    expect(written.capabilities.json_ld_article?.present).toBe(1);
    expect(written.capabilities.og_title?.sampled).toBe(1);
    expect(written.capabilities.og_title?.present).toBe(1);
  });
});

describe("shouldSkipJsonLdPostExtract", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    _clearWriteLocksForTests();
  });

  it("returns false when no record exists", async () => {
    cacheGetMock.mockResolvedValue(null);
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      false,
    );
  });

  it("returns false until 5 samples are recorded with zero hits", async () => {
    const seed: DomainRecord = {
      schema_version: 1,
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
        tier1: { attempts: 0, ok: 0, fail: 0 },
        tier2: { attempts: 0, ok: 0, fail: 0 },
        tier3: { attempts: 0, ok: 0, fail: 0 },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      false,
    );
  });

  it("returns true after 5+ samples with zero JSON-LD hits", async () => {
    const seed: DomainRecord = {
      schema_version: 1,
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
        tier1: { attempts: 0, ok: 0, fail: 0 },
        tier2: { attempts: 0, ok: 0, fail: 0 },
        tier3: { attempts: 0, ok: 0, fail: 0 },
      },
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(seed));
    expect(await shouldSkipJsonLdPostExtract("https://example.com/p")).toBe(
      true,
    );
  });

  it("returns false once any JSON-LD hit has been seen, regardless of sample count", async () => {
    const seed: DomainRecord = {
      schema_version: 1,
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
        tier1: { attempts: 0, ok: 0, fail: 0 },
        tier2: { attempts: 0, ok: 0, fail: 0 },
        tier3: { attempts: 0, ok: 0, fail: 0 },
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
});
