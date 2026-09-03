/**
 * `min_score` — a relevance floor applied after reranking.
 *
 * The two things worth testing here are both about WHICH number is compared
 * and WHAT HAPPENS WHEN THERE IS NO NUMBER:
 *
 * 1. It filters on the RAW `relevance_score`, not on the value `rerank()`
 *    sorts by. That sort key is `relevance_score + RERANK_RECENCY_WEIGHT *
 *    recencyScore(publishedDate)`, which with the default weight of 0.15 ranges
 *    over 0..1.15. Filtering a parameter called "minimum relevance" on a
 *    recency-inflated number would let a recent-but-irrelevant document through
 *    a threshold the caller believed was about relevance. `filters on raw
 *    relevance, not the recency-inflated sort score` is the test that pins it.
 *
 * 2. When the reranker is down there are no scores at all, so the filter cannot
 *    be applied. It becomes a no-op AND SAYS SO. Returning unfiltered results
 *    silently would let a caller believe a floor had been applied.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/observability.js", () => ({
  withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
}));

import { resetLogThrottle } from "../src/log.js";
import { rerankWithFallback } from "../src/reranker.js";
import type { SearxResult } from "../src/types.js";

const result = (title: string, publishedDate?: string): SearxResult => ({
  title,
  url: `https://example.com/${title}`,
  content: `content for ${title}`,
  engines: ["stub"],
  ...(publishedDate ? { publishedDate } : {}),
});

/** Mock the reranker HTTP endpoint with a fixed score per document index. */
function stubReranker(scores: number[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      results: scores.map((relevance_score, index) => ({
        index,
        relevance_score,
      })),
    }),
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const errSpy = () => vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  resetLogThrottle();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("min_score — default behaviour", () => {
  it("omitting it changes nothing", async () => {
    stubReranker([0.9, 0.5, 0.001]);
    const input = [result("a"), result("b"), result("c")];

    const withOut = await rerankWithFallback("q", input, 10);
    expect(withOut.map((r) => r.title)).toEqual(["a", "b", "c"]);
  });

  it("a threshold of 0 keeps everything", async () => {
    stubReranker([0.9, 0.5, 0.0]);
    const input = [result("a"), result("b"), result("c")];

    const out = await rerankWithFallback("q", input, 10, undefined, 0);
    expect(out).toHaveLength(3);
  });
});

describe("min_score — filtering", () => {
  it("drops results below the threshold", async () => {
    // The measured live distribution: relevant near 1.0, irrelevant near 0.
    stubReranker([0.998, 0.967, 0.0028, 0.0000151]);
    const input = [
      result("nginx"),
      result("apache"),
      result("install"),
      result("banana"),
    ];

    const out = await rerankWithFallback("q", input, 10, undefined, 0.01);
    expect(out.map((r) => r.title)).toEqual(["nginx", "apache"]);
  });

  it("returns an empty list when nothing clears the floor", async () => {
    stubReranker([0.001, 0.002]);
    const input = [result("a"), result("b")];

    expect(await rerankWithFallback("q", input, 10, undefined, 0.9)).toEqual(
      [],
    );
  });

  it("filters BEFORE slicing to topN, so the floor does not cost results", async () => {
    // This ordering is only observable when a BELOW-threshold result would
    // otherwise occupy a top-N slot. Sorting is by the recency-adjusted score
    // while filtering is on raw relevance, so recency is what lets a result the
    // floor rejects outrank one it accepts:
    //
    //   a      raw 0.95, no date  -> sorts 0.95   keep
    //   fresh  raw 0.30, today    -> sorts ~0.45  DROP (raw 0.30 < 0.4)
    //   c      raw 0.42, no date  -> sorts 0.42   keep
    //
    // Filter-then-slice returns [a, c]. Slice-then-filter takes [a, fresh]
    // first and then drops fresh, returning just [a] — a result lost to a
    // floor it actually cleared.
    //
    // An earlier version of this test used a low-relevance, undated result,
    // which sorted last anyway and so passed under BOTH orderings.
    stubReranker([0.95, 0.3, 0.42]);
    const today = new Date().toISOString();
    const input = [result("a"), result("fresh", today), result("c")];

    const out = await rerankWithFallback("q", input, 2, undefined, 0.4);
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it("is inclusive at the boundary", async () => {
    stubReranker([0.5, 0.4999]);
    const input = [result("at"), result("below")];

    const out = await rerankWithFallback("q", input, 10, undefined, 0.5);
    expect(out.map((r) => r.title)).toEqual(["at"]);
  });
});

describe("min_score — which score it compares", () => {
  it("filters on raw relevance, not the recency-inflated sort score", async () => {
    // THE central test of this phase.
    //
    // "fresh" scores 0.30 raw and is published today, so with the default
    // RERANK_RECENCY_WEIGHT of 0.15 its combined sort score is ~0.45 — above a
    // 0.40 threshold. Its RAW relevance is 0.30, below it.
    //
    // Filtering on the combined score would keep "fresh"; filtering on raw
    // relevance drops it. If this test ever flips, a "minimum relevance"
    // parameter has silently started meaning "minimum relevance or recent
    // enough", which is the trap the plan called out.
    stubReranker([0.3, 0.95]);
    const today = new Date().toISOString();
    const input = [result("fresh", today), result("relevant")];

    const out = await rerankWithFallback("q", input, 10, undefined, 0.4);
    expect(out.map((r) => r.title)).toEqual(["relevant"]);
  });

  it("still ORDERS by the recency-adjusted score", async () => {
    // Filtering on raw relevance must not disturb ranking: recency still wins
    // the sort among results that clear the floor.
    stubReranker([0.6, 0.65]);
    const today = new Date().toISOString();
    const input = [result("recent", today), result("stale")];

    // Both clear 0.5. "recent" gets +0.15*~1.0 => ~0.75 vs "stale" 0.65.
    const out = await rerankWithFallback("q", input, 10, undefined, 0.5);
    expect(out.map((r) => r.title)).toEqual(["recent", "stale"]);
  });

  it("does not apply recency at all when time_range is set", async () => {
    // Pre-existing behaviour, pinned because min_score now shares this path.
    stubReranker([0.6, 0.65]);
    const today = new Date().toISOString();
    const input = [result("recent", today), result("stale")];

    const out = await rerankWithFallback("q", input, 10, "month", 0.5);
    expect(out.map((r) => r.title)).toEqual(["stale", "recent"]);
  });
});

describe("min_score — degraded reranker", () => {
  it("becomes a no-op rather than emptying the result set", async () => {
    // Returning [] here would turn a reranker outage into "no results found".
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const spy = errSpy();
    const input = [result("a"), result("b"), result("c")];

    const out = await rerankWithFallback("q", input, 10, undefined, 0.9);
    expect(out.map((r) => r.title)).toEqual(["a", "b", "c"]);
    spy.mockRestore();
  });

  it("announces the no-op instead of silently returning unfiltered results", async () => {
    // A silent unfiltered response is the worst option: the caller believes a
    // relevance floor was applied when none was.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const spy = errSpy();

    await rerankWithFallback("q", [result("a")], 10, undefined, 0.9);

    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("min_score=0.9 ignored");
    expect(logged).toContain("reranker unavailable");
    spy.mockRestore();
  });

  it("says nothing extra about min_score when it was not requested", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const spy = errSpy();

    await rerankWithFallback("q", [result("a")], 10);

    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("reranker unavailable");
    expect(logged).not.toContain("min_score");
    spy.mockRestore();
  });

  it("throttles the no-op warning rather than logging per call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const spy = errSpy();

    for (let i = 0; i < 5; i++) {
      await rerankWithFallback("q", [result("a")], 10, undefined, 0.9);
    }

    const lines = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("min_score"));
    expect(lines).toHaveLength(1);
    spy.mockRestore();
  });
});
