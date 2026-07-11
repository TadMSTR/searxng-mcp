// Verifies the fast-path routing decision added when github.ts was wired
// into the cascade: a GitHub URL must bypass robots/tier1-3 entirely, and a
// non-GitHub URL must never touch githubFetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  WAYBACK_ENABLED: false,
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
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

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

vi.mock("../src/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn().mockResolvedValue({
    title: "github result",
    url: "https://raw.githubusercontent.com/a/b/main/f.txt",
    text: "file contents",
  }),
  isGithubUrl: (url: string) =>
    ["github.com", "raw.githubusercontent.com", "api.github.com"].includes(
      new URL(url).hostname,
    ),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { fetchPage } from "../src/fetch.js";
import { tryLlmsTxtFetch } from "../src/llms-txt.js";
import { checkRobots } from "../src/robots.js";
import { githubFetch } from "../src/tiers/index.js";

const githubFetchMock = vi.mocked(githubFetch);
const checkRobotsMock = vi.mocked(checkRobots);
const llmsTxtMock = vi.mocked(tryLlmsTxtFetch);

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

  it("routes github.com through githubFetch", async () => {
    await fetchPage("https://github.com/a/b");
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
