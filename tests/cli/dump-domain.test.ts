import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/domain-db.js", () => ({
  getDomainRecord: vi.fn(),
  normalizeHostname: vi.fn((input: string) => {
    try {
      const host = input.includes("://")
        ? new URL(input).hostname
        : input.trim();
      return host.replace(/^www\./i, "").toLowerCase() || null;
    } catch {
      return null;
    }
  }),
}));

import { main } from "../../src/cli/dump-domain.js";
import { getDomainRecord } from "../../src/domain-db.js";

const getDomainRecordMock = vi.mocked(getDomainRecord);

const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: NOW };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dump-domain CLI — present-domain case", () => {
  it("prints the JSON record and a formatted tier summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv[2] = "docs.example.com";
    getDomainRecordMock.mockResolvedValueOnce({
      schema_version: 3,
      domain: "docs.example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-06-01T00:00:00Z",
      capabilities: {
        metadata_fetch: {
          attempts: 4,
          ok: 3,
          fail: 1,
          last_checked: "2026-06-01T00:00:00Z",
        },
        seen_in_search: {
          count: 7,
          last_seen_at: "2026-06-01T00:00:00Z",
        },
      },
      tier_stats_30d: {
        tier1: stat(10, 9, 1),
        tier2: stat(2, 0, 2),
        tier3: stat(0, 0, 0),
        tier4: stat(3, 2, 1),
      },
    });

    const code = await main();

    expect(code).toBe(0);
    expect(getDomainRecordMock).toHaveBeenCalledWith("docs.example.com");
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain('"domain": "docs.example.com"');
    expect(output).toContain("tier stats (30d window)");
    expect(output).toContain("tier1 (firecrawl)");
    expect(output).toContain("90% ok (9/10)");
    expect(output).toContain("tier2 (crawl4ai)");
    expect(output).toContain("0% ok (0/2)");
    expect(output).toContain("tier3 (raw)");
    expect(output).toContain("tier4 (wayback)");
    expect(output).toContain("67% ok (2/3)");
    expect(output).toContain("metadata_fetch");
    expect(output).toContain("75% ok (3/4)");
    expect(output).toContain("seen_in_search");
    expect(output).toContain("7x");
  });

  it("shows 'no data' for tier3 and defaults for capabilities that have never been recorded", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv[2] = "sparse.example.com";
    getDomainRecordMock.mockResolvedValueOnce({
      schema_version: 3,
      domain: "sparse.example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-06-01T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: stat(10, 9, 1),
        tier2: stat(2, 0, 2),
        tier3: stat(0, 0, 0),
        tier4: stat(0, 0, 0),
      },
    });

    await main();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("tier3 (raw)");
    expect(output).toContain("no data");
    expect(output).toContain("metadata_fetch   : no data");
    expect(output).toContain("seen_in_search   : never seen in search results");
  });

  it("includes last_fail_reason in the tier summary when present", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv[2] = "flaky.example.com";
    getDomainRecordMock.mockResolvedValueOnce({
      schema_version: 3,
      domain: "flaky.example.com",
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-06-01T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: { ...stat(3, 0, 3), last_fail_reason: "timeout" },
        tier2: stat(0, 0, 0),
        tier3: stat(0, 0, 0),
        tier4: stat(0, 0, 0),
      },
    });

    await main();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("last fail: timeout");
  });
});

describe("dump-domain CLI — missing-domain case", () => {
  it("prints a no-record message and returns exit code 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv[2] = "never-seen.example.com";
    getDomainRecordMock.mockResolvedValueOnce(null);

    const code = await main();

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("no record for never-seen.example.com");
  });
});

describe("dump-domain CLI — argument handling", () => {
  it("returns exit code 2 and prints usage when no hostname arg is given", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalArgv2 = process.argv[2];
    process.argv.length = 2; // drop argv[2]

    const code = await main();

    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith("Usage: dump-domain <hostname-or-url>");
    expect(getDomainRecordMock).not.toHaveBeenCalled();

    process.argv[2] = originalArgv2;
  });

  it("returns exit code 2 when the hostname cannot be parsed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[2] = "://not-a-valid-target";

    const code = await main();

    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not parse hostname"),
    );
  });
});
