/**
 * Labels on the shared `search` histogram, and latency on the failure path.
 *
 * All three search tools record into ONE histogram. Before this it carried only
 * `profile`, so a duration could not be attributed to the tool that produced
 * it — and the three have very different normal ranges (a plain `search` is
 * bounded around ~17.5s; `search_and_summarize` routinely runs to ~50s because
 * it adds up to five fetches and an Ollama call). The 7-day maximum of 51.6s
 * was therefore uninterpretable: routine for one tool, alarming for another.
 *
 * The failure path recorded no duration at all, only `errors_total`, so a
 * search that failed after 40s looked exactly like one that failed instantly.
 *
 * NOT covered here, deliberately: a *hang*. Both recordings happen after
 * `await fn()` settles, so a call that never returns still records nothing.
 * That is a real remaining gap and needs a watchdog, not a label.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(0),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      {
        title: "R1",
        url: "https://example.com/1",
        content: "c",
        engines: ["google"],
      },
    ],
    meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_q, results) => Promise.resolve(results)),
}));

vi.mock("../src/fetch.js", () => ({
  fetchPage: vi.fn().mockResolvedValue({
    title: "P",
    url: "https://example.com/1",
    text: "text",
  }),
}));

vi.mock("../src/ollama.js", () => ({
  summarizePages: vi.fn().mockResolvedValue({ summary: "s", citations: [] }),
  formatSummaryResult: vi.fn().mockReturnValue("## Summary"),
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("req"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { incCounter, recordHistogram } from "../src/observability.js";
import { searxSearch } from "../src/search.js";
import {
  handleSearch,
  handleSearchAndFetch,
  handleSearchAndSummarize,
} from "../src/tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

/** The single `recordHistogram("search", ...)` call, or a clear failure. */
function soleSearchHistogram() {
  const calls = vi
    .mocked(recordHistogram)
    .mock.calls.filter((c) => c[0] === "search");
  expect(calls).toHaveLength(1);
  return { seconds: calls[0][1], attrs: calls[0][2] };
}

describe("search histogram — tool label", () => {
  const cases = [
    ["search", () => handleSearch({ query: "q", num_results: 3 })],
    [
      "search_and_fetch",
      () => handleSearchAndFetch({ query: "q", fetch_count: 1 }),
    ],
    [
      "search_and_summarize",
      () => handleSearchAndSummarize({ query: "q", fetch_count: 1 }),
    ],
  ] as const;

  for (const [toolName, invoke] of cases) {
    it(`records the histogram labelled tool=${toolName}`, async () => {
      await invoke();
      expect(soleSearchHistogram().attrs).toMatchObject({
        tool: toolName,
        outcome: "ok",
      });
    });

    it(`records the counter labelled tool=${toolName}`, async () => {
      await invoke();
      const calls = vi
        .mocked(incCounter)
        .mock.calls.filter((c) => c[0] === "search");
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ tool: toolName });
    });
  }

  it("gives the three tools three DIFFERENT labels", async () => {
    // The point of the label is discrimination. Asserting each tool's value in
    // isolation would still pass if every one of them emitted "search".
    const seen: string[] = [];
    for (const [, invoke] of cases) {
      vi.clearAllMocks();
      await invoke();
      seen.push(soleSearchHistogram().attrs?.tool as string);
    }
    expect(new Set(seen).size).toBe(3);
  });
});

describe("search histogram — failure path", () => {
  it("records a duration when the search throws, not just an error count", async () => {
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("searxng down"));

    // Pin the clock so the assertion is on a REAL elapsed value. Asserting
    // `any(Number)` would pass against a hardcoded zero, which is the exact
    // failure this phase is meant to make visible.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(41_000);

    await expect(handleSearch({ query: "q", num_results: 3 })).rejects.toThrow(
      "searxng down",
    );
    now.mockRestore();

    const { seconds, attrs } = soleSearchHistogram();
    expect(seconds).toBe(40);
    expect(attrs).toMatchObject({ tool: "search", outcome: "error" });
  });

  it("labels the error counter with the tool", async () => {
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("boom"));
    await expect(
      handleSearchAndFetch({ query: "q", fetch_count: 1 }),
    ).rejects.toThrow("boom");

    const errCalls = vi
      .mocked(incCounter)
      .mock.calls.filter((c) => c[0] === "errors");
    expect(errCalls).toHaveLength(1);
    expect(errCalls[0][1]).toMatchObject({
      tool: "search_and_fetch",
      stage: "search",
    });
  });

  it("separates ok from error via outcome rather than merging the two", async () => {
    // Without `outcome`, error latencies would land in the same series as
    // successes and skew the p99 the histogram exists to report.
    await handleSearch({ query: "q", num_results: 3 });
    const ok = soleSearchHistogram().attrs?.outcome;

    vi.clearAllMocks();
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("x"));
    await expect(
      handleSearch({ query: "q", num_results: 3 }),
    ).rejects.toThrow();
    const err = soleSearchHistogram().attrs?.outcome;

    expect(ok).toBe("ok");
    expect(err).toBe("error");
  });
});
