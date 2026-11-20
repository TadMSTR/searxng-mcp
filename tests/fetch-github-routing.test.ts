// Verifies the fast-path routing decision added when github.ts was wired
// into the cascade: a GitHub URL must bypass robots/tier1-3 entirely, and a
// non-GitHub URL must never touch githubFetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  WAYBACK_ENABLED: false,
  YOUTUBE_TRANSCRIPT_ENABLED: false,
  YOUTUBE_IGNORE_ROBOTS: false,
  REDDIT_FASTPATH_ENABLED: false,
  REDDIT_IGNORE_ROBOTS: false,
}));

// Pre-resolve SSRF guard resolves hostnames before the tier cascade — stub it
// to a public address so tests don't make real DNS queries. Plain function so
// mock resets don't wipe the resolved value.
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  fetchCacheKey: (url: string) => `fetch:${url}`,
}));

vi.mock("../src/domains.js", () => ({
  getBlockList: vi.fn(() => []),
  urlMatchesDomain: vi.fn(() => false),
}));

vi.mock("../src/domain-db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
  recordPostExtractSample: vi.fn().mockResolvedValue(undefined),
  recordMetadataFetchAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  events: {
    fetchRequested: vi.fn(),
    fetchCompleted: vi.fn(),
    fetchTierMiss: vi.fn(),
    fetchTierSkipped: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../src/hister.js", () => ({
  // histerConfigured returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes, histerFetch
  // is called, and it misses. Mocking it false would make the fast path vanish
  // from every test in this file rather than miss in it.
  histerConfigured: vi.fn().mockReturnValue(true),
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  // isLlmsTxtDomain returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes,
  // tryLlmsTxtFetch is called, and it misses. Mocking it false would make the
  // fast path vanish from every test in this file rather than miss in it, which
  // is a quieter kind of green.
  isLlmsTxtDomain: vi.fn().mockReturnValue(true),
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

const cascade = vi.hoisted(() => ({ tier1Fetch: vi.fn() }));

vi.mock("../src/routing.js", () => ({
  getTiers: vi.fn().mockResolvedValue({ active: [], skipped: [] }),
  TIER_NAME: {},
}));

vi.mock("../src/extractors/post-extract.js", () => ({
  postExtract: vi.fn(() => ({
    title: "t",
    text: "x",
    source: "readability",
  })),
}));

vi.mock("../src/tiers/index.js", async () => {
  const real = await vi.importActual<typeof import("../src/tiers/github.js")>(
    "../src/tiers/github.js",
  );
  return {
    // The real routing predicates: which github.com shapes take the fast path,
    // and which fall back, is exactly what this file tests, so a hand-copied
    // stand-in would test itself.
    isGithubFastPathUrl: real.isGithubFastPathUrl,
    githubFallsBackToCascade: real.githubFallsBackToCascade,
    GithubFastPathError: real.GithubFastPathError,
    fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
    githubFetch: vi.fn().mockResolvedValue({
      title: "github result",
      url: "https://raw.githubusercontent.com/a/b/main/f.txt",
      text: "file contents",
    }),
    tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
    waybackFetch: vi.fn().mockResolvedValue(null),
  };
});

import { recordTierAttempt } from "../src/domain-db.js";
import { events } from "../src/events.js";
import { fetchPage } from "../src/fetch.js";
import { tryLlmsTxtFetch } from "../src/llms-txt.js";
import { checkRobots } from "../src/robots.js";
import { getTiers } from "../src/routing.js";
import { githubFetch } from "../src/tiers/index.js";

const githubFetchMock = vi.mocked(githubFetch);
const checkRobotsMock = vi.mocked(checkRobots);
const llmsTxtMock = vi.mocked(tryLlmsTxtFetch);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);

beforeEach(() => {
  vi.clearAllMocks();
  checkRobotsMock.mockResolvedValue({ allowed: true });
  llmsTxtMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchPage — GitHub fast path", () => {
  it("routes raw.githubusercontent.com through githubFetch, bypassing the tier cascade", async () => {
    githubFetchMock.mockResolvedValueOnce({
      title: "f.txt",
      url: "https://raw.githubusercontent.com/a/b/main/f.txt",
      text: "file contents",
    });
    const result = await fetchPage(
      "https://raw.githubusercontent.com/a/b/main/f.txt",
    );
    expect(githubFetchMock).toHaveBeenCalledOnce();
    expect(result.text).toBe("file contents");
    // Bypass proof: robots.txt gate and llms.txt fast path are cascade-only
    // steps and must not run for a GitHub URL.
    expect(checkRobotsMock).not.toHaveBeenCalled();
    expect(llmsTxtMock).not.toHaveBeenCalled();
  });

  it("routes api.github.com through githubFetch", async () => {
    await fetchPage("https://api.github.com/repos/a/b");
    expect(githubFetchMock).toHaveBeenCalledOnce();
  });

  it("records a github tier hit in the domain-db (SXNG-10)", async () => {
    githubFetchMock.mockResolvedValueOnce({
      title: "f.txt",
      url: "https://raw.githubusercontent.com/a/b/main/f.txt",
      text: "file contents",
    });
    await fetchPage("https://raw.githubusercontent.com/a/b/main/f.txt");
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/a/b/main/f.txt",
      "github",
      "hit",
    );
  });

  it("records a github tier error and rethrows when githubFetch fails (SXNG-10)", async () => {
    githubFetchMock.mockRejectedValueOnce(
      new Error("GitHub API error: 404 Not Found"),
    );
    await expect(
      fetchPage("https://github.com/a/b/releases/tag/v9"),
    ).rejects.toThrow("GitHub fast-path fetch failed");
    // runTier swallowed the original error but recorded it as a tier error.
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      "https://github.com/a/b/releases/tag/v9",
      "github",
      "error",
      "GitHub API error: 404 Not Found",
    );
  });

  it("routes github.com through githubFetch", async () => {
    await fetchPage("https://github.com/a/b");
    expect(githubFetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "https://github.com/valkey-io/valkey/issues/1234",
    "https://github.com/valkey-io/valkey/pull/1234",
    "https://github.com/valkey-io",
  ])(
    "sends %s down the normal cascade, not the README fast path",
    async (url) => {
      // Used to return the repo-root README as if it were this page.
      await expect(fetchPage(url)).rejects.toThrow("All fetch tiers failed");
      expect(githubFetchMock).not.toHaveBeenCalled();
      expect(checkRobotsMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "https://github.com/a/b/tree/main/docs",
    "https://github.com/a/b/releases",
    "https://github.com/a/b/releases/tag/v1.0",
  ])("routes %s through githubFetch", async (url) => {
    await fetchPage(url);
    expect(githubFetchMock).toHaveBeenCalledOnce();
  });

  it("does not call githubFetch for a non-GitHub URL, and falls through to the normal cascade", async () => {
    await expect(fetchPage("https://example.com/page")).rejects.toThrow(
      "All fetch tiers failed",
    );
    expect(githubFetchMock).not.toHaveBeenCalled();
    // Fell all the way through the fast paths and hit the robots gate,
    // proving normal-cascade routing.
    expect(checkRobotsMock).toHaveBeenCalledOnce();
  });
});

// #1570: the fast path's failure cause was thrown away, and a GitHub file URL
// never reached the cascade.
describe("fetchPage — GitHub fast-path failure", () => {
  const BLOB = "https://github.com/a/b/blob/main/gone.md";
  const RAW = "https://raw.githubusercontent.com/a/b/main/gone.md";

  afterEach(() => {
    vi.mocked(getTiers).mockResolvedValue({ active: [], skipped: [] });
  });

  it.each([
    ["releases", "https://github.com/a/b/releases/tag/31.0.0"],
    ["repo root", "https://github.com/a/b"],
    ["tree", "https://github.com/a/b/tree/main/docs"],
    ["api", "https://api.github.com/repos/a/b/contents/x"],
  ])(
    "%s: throws with the tier's reason, and never runs the cascade",
    async (_n, url) => {
      githubFetchMock.mockRejectedValueOnce(
        new Error("GitHub API error: 404 Not Found"),
      );
      const err = await fetchPage(url).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("GithubFastPathError");
      expect((err as Error).message).toBe(
        "GitHub fast-path fetch failed: GitHub API error: 404 Not Found",
      );
      expect(vi.mocked(events.error)).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: "github_fetch_failed",
          message: expect.stringContaining("404 Not Found"),
        }),
      );
      expect(checkRobotsMock).not.toHaveBeenCalled();
    },
  );

  it("blob: a fast-path 404 falls through to tier 1, which serves it", async () => {
    githubFetchMock.mockRejectedValueOnce(
      new Error("GitHub raw fetch error: 404 Not Found"),
    );
    cascade.tier1Fetch.mockResolvedValueOnce({
      title: "rendered",
      url: BLOB,
      text: "page body",
      html: "<p>page body</p>",
    });
    vi.mocked(getTiers).mockResolvedValueOnce({
      active: [
        { name: "tier1_firecrawl", slot: "tier1", fetch: cascade.tier1Fetch },
      ],
      skipped: [],
    } as unknown as Awaited<ReturnType<typeof getTiers>>);

    const r = await fetchPage(BLOB);

    expect(r.text).toBe("x"); // post-extract mock output
    expect(cascade.tier1Fetch).toHaveBeenCalledOnce();
    expect(checkRobotsMock).toHaveBeenCalledOnce();
    expect(vi.mocked(events.fetchCompleted).mock.calls[0][0].tier_served).toBe(
      "tier1_firecrawl",
    );
  });

  it("raw: when the cascade fails too, the error leads with the GitHub cause", async () => {
    githubFetchMock.mockRejectedValueOnce(
      new Error("GitHub raw fetch error: 404 Not Found"),
    );
    await expect(fetchPage(RAW)).rejects.toThrow(
      "All fetch tiers failed — github: GitHub raw fetch error: 404 Not Found",
    );
    expect(checkRobotsMock).toHaveBeenCalledOnce();
  });

  it("a fallback refused by robots.txt still names the GitHub cause", async () => {
    githubFetchMock.mockRejectedValueOnce(
      new Error("GitHub raw fetch error: 429 Too Many Requests"),
    );
    checkRobotsMock.mockResolvedValueOnce({ allowed: false });
    const err = await fetchPage(BLOB).catch((e: Error) => e);
    expect((err as Error).name).toBe("RobotsDisallowedError");
    expect((err as Error).message).toMatch(
      /^GitHub fast path failed \(GitHub raw fetch error: 429 Too Many Requests\), then: /,
    );
  });
});
