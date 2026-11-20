// Fallback counters and rerank span attributes (4.1.0).
//
// Before 4.1.0 every degrade path was a throttled log line and nothing else,
// so "how often does the reranker fall back" had no answer: the throttle hides
// all but the first occurrence per window. searxng_degrade_total counts every
// occurrence. The rerank span gained the numbers the checkpoint needs to tune
// min_score: whether the reranker ran, and what it scored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spans = vi.hoisted(() => ({
  attrs: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn(
    (name: string, _a: unknown, fn: (s: unknown) => unknown): unknown => {
      const span = {
        setAttributes: (a: Record<string, unknown>) => {
          spans.attrs[name] ??= [];
          spans.attrs[name].push(a);
        },
      };
      return fn(span);
    },
  ),
}));

import { resetLogThrottle } from "../src/log.js";
import { incCounter, recordHistogram } from "../src/observability.js";
import type { SearxResult } from "../src/types.js";

const result = (title: string): SearxResult => ({
  title,
  url: `https://example.com/${title}`,
  content: `content for ${title}`,
  engines: ["stub"],
});
const pool = [result("a"), result("b"), result("c")];

function stubReranker(scores: number[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: scores.map((relevance_score, index) => ({
          index,
          relevance_score,
        })),
      }),
    } as Response),
  );
}

const degradeCalls = () =>
  vi
    .mocked(incCounter)
    .mock.calls.filter((c) => c[0] === "degrade")
    .map((c) => c[1]);

beforeEach(() => {
  spans.attrs = {};
  resetLogThrottle();
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rerank span and top-score histogram", () => {
  it("a reranked search records applied, counts and raw scores", async () => {
    vi.stubEnv("RERANKER_URL", "http://reranker.example:8787");
    vi.stubEnv("RERANK_RECENCY_WEIGHT", "0");
    stubReranker([0.9, 0.2, 0.6]);
    const { rerankWithFallback } = await import("../src/reranker.js");

    const out = await rerankWithFallback("q", pool, 5, undefined, 0.5);

    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
    expect(spans.attrs.rerank).toEqual([
      {
        "rerank.applied": true,
        "rerank.returned": 2,
        "rerank.top_score": 0.9,
        "rerank.min_returned_score": 0.6,
        "rerank.dropped_by_min_score": 1,
      },
    ]);
    expect(recordHistogram).toHaveBeenCalledWith("rerank_top_score", 0.9);
    expect(degradeCalls()).toEqual([]);
  });

  it("an empty pool records no score and no histogram point", async () => {
    vi.stubEnv("RERANKER_URL", "http://reranker.example:8787");
    stubReranker([]);
    const { rerankWithFallback } = await import("../src/reranker.js");

    expect(await rerankWithFallback("q", [], 5)).toEqual([]);
    expect(spans.attrs.rerank).toEqual([
      {
        "rerank.applied": true,
        "rerank.returned": 0,
        "rerank.dropped_by_min_score": 0,
      },
    ]);
    expect(recordHistogram).not.toHaveBeenCalled();
  });

  it("min_score above every score returns nothing, with the top score kept", async () => {
    vi.stubEnv("RERANKER_URL", "http://reranker.example:8787");
    stubReranker([0.3, 0.1, 0.2]);
    const { rerankWithFallback } = await import("../src/reranker.js");

    expect(await rerankWithFallback("q", pool, 5, undefined, 0.95)).toEqual([]);
    expect(spans.attrs.rerank?.[0]).toEqual({
      "rerank.applied": true,
      "rerank.returned": 0,
      "rerank.top_score": 0.3,
      "rerank.dropped_by_min_score": 3,
    });
    // The histogram answers "what does the best candidate score", which is
    // still a fact when min_score dropped it.
    expect(recordHistogram).toHaveBeenCalledWith("rerank_top_score", 0.3);
  });

  it('RERANKER_URL="" is applied=false and not a degrade', async () => {
    vi.stubEnv("RERANKER_URL", "");
    const { rerankWithFallback } = await import("../src/reranker.js");

    expect(await rerankWithFallback("q", pool, 2)).toHaveLength(2);
    expect(spans.attrs.rerank).toEqual([
      { "rerank.applied": false, "rerank.returned": 2 },
    ]);
    expect(degradeCalls()).toEqual([]);
    expect(recordHistogram).not.toHaveBeenCalled();
  });

  it("a reranker failure is applied=false and counted on every call", async () => {
    vi.stubEnv("RERANKER_URL", "http://reranker.example:8787");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));
    const { rerankWithFallback } = await import("../src/reranker.js");

    await rerankWithFallback("q", pool, 2);
    await rerankWithFallback("q", pool, 2, undefined, 0.5);

    expect(spans.attrs.rerank).toEqual([
      { "rerank.applied": false, "rerank.returned": 2 },
      { "rerank.applied": false, "rerank.returned": 2 },
    ]);
    // Twice, although the throttled log line printed once.
    expect(degradeCalls()).toEqual([
      { component: "reranker", reason: "unavailable" },
      { component: "reranker", reason: "unavailable" },
      { component: "reranker", reason: "min_score_ignored" },
    ]);
  });
});

describe("ollama degrade counters", () => {
  async function loadOllama() {
    vi.stubEnv("OLLAMA_URL", "http://ollama.example:11434");
    vi.stubEnv("LLM_BASE_URL", "");
    return import("../src/ollama.js");
  }
  const timeout = () =>
    Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const pages = [{ title: "t", url: "https://example.com/", text: "x" }];

  it.each([
    ["timeout", timeout()],
    ["error", new Error("ECONNREFUSED")],
  ])("query expansion: %s", async (reason, err) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    const { expandQuery } = await loadOllama();
    expect(await expandQuery("q")).toEqual([]);
    expect(degradeCalls()).toEqual([{ component: "ollama_expand", reason }]);
  });

  it.each([
    ["timeout", timeout()],
    ["llm_error", new Error("Ollama error: 500")],
  ])("summarization: %s", async (reason, err) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    const { summarizePages } = await loadOllama();
    await summarizePages("q", pages);
    expect(degradeCalls()).toEqual([{ component: "ollama_summarize", reason }]);
  });

  it("summarization: parse_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: "not json" } }),
      } as Response),
    );
    const { summarizePages } = await loadOllama();
    await summarizePages("q", pages);
    expect(degradeCalls()).toEqual([
      { component: "ollama_summarize", reason: "parse_error" },
    ]);
  });

  it("summarization: empty_response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ summary: "", citations: [] }) },
        }),
      } as Response),
    );
    const { summarizePages } = await loadOllama();
    await summarizePages("q", pages);
    expect(degradeCalls()).toEqual([
      { component: "ollama_summarize", reason: "empty_response" },
    ]);
  });

  it("not configured is not a degrade", async () => {
    vi.stubEnv("OLLAMA_URL", "");
    vi.stubEnv("LLM_BASE_URL", "");
    const { summarizePages, expandQuery } = await import("../src/ollama.js");
    await summarizePages("q", pages);
    await expandQuery("q");
    expect(degradeCalls()).toEqual([]);
  });
});
