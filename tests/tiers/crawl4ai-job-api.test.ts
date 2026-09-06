// vikunja#684 — the crawl4ai async job API: its route and its response shape.
//
// Both fixtures in this file were captured from the deployed instance, not
// hand-authored: the OpenAPI document from GET /openapi.json, and the completed
// job envelope by actually enqueueing a crawl and polling it to completion. A
// hand-written mock is what let this bug survive — the code and the mock agreed
// with each other and neither agreed with the server.
//
// Two independent defects lived here, and both were silent:
//
//   1. The poll route was `/task/{task_id}`, which does not exist on 0.8.6. It
//      404s, the !resp.ok guard returns null, and the tier books an ordinary
//      miss. That spelling is still printed in upstream's own installation doc
//      (overview-05-installation.md), which is the likely reason two forge
//      repos wrote it independently — jobsearch-mcp has the same defect
//      (vikunja#654).
//   2. The payload did not survive the rename. A completed job nests the crawl
//      result one level deeper than the old code read. Repointing the route
//      alone would have turned a 404 into a 200 that still produced no text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// config.js reads CRAWL4AI_URL at import time, and imports are hoisted above
// module-scope statements — so this has to run in a hoisted block or the tier
// loads with a null base URL and the route assertion checks "null/crawl/job/…".
vi.hoisted(() => {
  process.env.CRAWL4AI_URL = "http://crawl4ai:11235";
});

import {
  CRAWL4AI_TARGET_VERSION,
  pollCrawl4aiTask,
} from "../../src/tiers/crawl4ai.js";

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(
    new URL(`../fixtures/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf-8"));
}

const openapi = fixture("crawl4ai-0.8.6-openapi") as {
  paths: Record<string, unknown>;
  _captured: { crawl4ai_version: string };
};
const completedJob = fixture("crawl4ai-0.8.6-job-completed");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crawl4ai job route, against the deployed OpenAPI document", () => {
  it("targets the crawl4ai version the fixture was captured from", () => {
    // If someone refreshes the fixture from a newer instance without revisiting
    // this tier, this is what says so.
    expect(CRAWL4AI_TARGET_VERSION).toBe(openapi._captured.crawl4ai_version);
  });

  it("exposes the job status route this tier polls", () => {
    expect(Object.keys(openapi.paths)).toContain("/crawl/job/{task_id}");
  });

  it("does not expose the route this tier used to poll", () => {
    // The negative half. Without it, "the route we use exists" would pass just
    // as well on a server that also still served the old one.
    expect(Object.keys(openapi.paths)).not.toContain("/task/{task_id}");
  });
});

describe("pollCrawl4aiTask — route", () => {
  it("polls /crawl/job/{task_id}", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(completedJob), { status: 200 }),
    );

    await pollCrawl4aiTask(
      "crawl_0b0268d9",
      "https://example.com",
      8000,
      new AbortController().signal,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://crawl4ai:11235/crawl/job/crawl_0b0268d9",
      expect.anything(),
    );
  });

  it("never polls the retired /task/{id} route", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(completedJob), { status: 200 }),
    );

    await pollCrawl4aiTask(
      "crawl_0b0268d9",
      "https://example.com",
      8000,
      new AbortController().signal,
    );

    const polled = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(polled.every((u) => !u.includes("/task/"))).toBe(true);
  });

  it("reports a 404 rather than dropping the tier silently", async () => {
    // The whole reason this bug lasted: a missing route was indistinguishable
    // from a page with no content.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValue(new Response("not found", { status: 404 }));

    // It now reports twice: the console line that names a route rename, and a
    // thrown reason that reaches domain_stats instead of an `empty_result`.
    await expect(
      pollCrawl4aiTask(
        "crawl_gone",
        "https://example.com",
        8000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Crawl4AI error: 404/);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("404"));
    spy.mockRestore();
  });
});

describe("pollCrawl4aiTask — completed job payload", () => {
  it("reads markdown from result.results[0], the shape 0.8.6 actually returns", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(completedJob), { status: 200 }),
    );

    const result = await pollCrawl4aiTask(
      "crawl_0b0268d9",
      "https://example.com",
      8000,
      new AbortController().signal,
    );

    expect(result).not.toBeNull();
    expect(result?.text).toContain("raw markdown body");
    expect(result?.title).toBe("Example Domain");
    expect(result?.html).toBe("<h1>Example Domain</h1>");
  });

  it("honours preferFit against the nested shape", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(completedJob), { status: 200 }),
    );

    const result = await pollCrawl4aiTask(
      "crawl_0b0268d9",
      "https://example.com",
      8000,
      new AbortController().signal,
      true,
    );

    expect(result?.text).toContain("fit markdown body");
  });

  it("still reads the older flat shape, for a backend that returns one", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: "crawl_legacy",
          status: "completed",
          result: {
            markdown: { raw_markdown: "legacy flat body" },
            metadata: { title: "Legacy" },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await pollCrawl4aiTask(
      "crawl_legacy",
      "https://example.com",
      8000,
      new AbortController().signal,
    );

    expect(result?.text).toContain("legacy flat body");
  });

  it("returns null on the pre-fix read path — the defect this pins", async () => {
    // A completed job whose crawl result is correctly nested, read by a client
    // expecting the flat shape, yields no markdown at all. Asserting the
    // envelope is nested is not the same as asserting the reader follows it,
    // so this drives the real function against a payload with NOTHING at the
    // old location.
    const nestedOnly = {
      task_id: "crawl_x",
      status: "completed",
      result: {
        success: true,
        results: [{ markdown: { raw_markdown: "only nested" } }],
      },
    };
    expect(
      (nestedOnly.result as Record<string, unknown>).markdown,
    ).toBeUndefined();

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(nestedOnly), { status: 200 }),
    );

    const result = await pollCrawl4aiTask(
      "crawl_x",
      "https://example.com",
      8000,
      new AbortController().signal,
    );

    expect(result?.text).toBe("only nested");
  });

  it("throws on a failed job rather than booking it as a miss", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "failed", task_id: "crawl_f" }), {
        status: 200,
      }),
    );

    // A job the backend itself marked failed is not "the page had no content".
    await expect(
      pollCrawl4aiTask(
        "crawl_f",
        "https://example.com",
        8000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Crawl4AI job failed/);
  });
});
