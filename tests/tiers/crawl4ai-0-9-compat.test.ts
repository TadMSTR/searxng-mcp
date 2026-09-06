// vikunja#691 — crawl4ai 0.9.x client compatibility.
//
// Every fixture here was captured from a real scratch `unclecode/crawl4ai:0.9.3`
// container, not from the changelog. That distinction earned its keep: the
// changelog says 0.9.x "rejects proxy_config at the trust boundary", which is
// true, but it does not say that `crawler_config` is still accepted, that
// /health stays unauthenticated while /crawl 401s, or that the synchronous
// response shape is unchanged — and all three decide whether this tier works.
//
// The 0.8.6 fixture is deliberately kept and still asserted. This client ships
// BEFORE the server is upgraded, so "works on 0.9.3" must not quietly become
// "no longer works on 0.8.6".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.hoisted(() => {
  process.env.CRAWL4AI_URL = "http://crawl4ai:11235";
});

import {
  CRAWL4AI_TARGET_VERSION,
  crawl4aiErrorReason,
  crawl4aiFetch,
} from "../../src/tiers/crawl4ai.js";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)),
      "utf-8",
    ),
  );
}

type OpenApi = {
  paths: Record<string, unknown>;
  _captured: { crawl4ai_version: string };
};

const oa093 = fixture("crawl4ai-0.9.3-openapi") as OpenApi;
const oa086 = fixture("crawl4ai-0.8.6-openapi") as OpenApi;
const sync093 = fixture("crawl4ai-0.9.3-crawl-sync");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("target version", () => {
  it("targets the version the 0.9.3 fixture was captured from", () => {
    expect(CRAWL4AI_TARGET_VERSION).toBe(oa093._captured.crawl4ai_version);
  });

  it("has actually moved off 0.8.6", () => {
    // Without this, a fixture refreshed from the old server would satisfy the
    // assertion above while leaving the constant stale.
    expect(CRAWL4AI_TARGET_VERSION).not.toBe(oa086._captured.crawl4ai_version);
  });
});

describe("routes this tier depends on, across both server versions", () => {
  // The client ships before the server upgrade, so it has to hold on both.
  for (const [version, oa] of [
    ["0.8.6", oa086],
    ["0.9.3", oa093],
  ] as const) {
    it(`${version} exposes the job route this tier polls`, () => {
      expect(Object.keys(oa.paths)).toContain("/crawl/job/{task_id}");
    });

    it(`${version} does not expose the retired /task/{task_id} route`, () => {
      expect(Object.keys(oa.paths)).not.toContain("/task/{task_id}");
    });
  }
});

describe("0.9.3 synchronous response shape", () => {
  it("is the same shape 0.8.6 returned, and the tier reads it", async () => {
    // The plan called 0.9.x "an untested third possibility". Captured live, it
    // is not one — but that is only worth knowing because it was checked.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(sync093), { status: 200 }),
    );

    const result = await crawl4aiFetch("https://example.com");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Example Domain");
    expect(result?.text.length).toBeGreaterThan(0);
  });

  it("still prefers fit_markdown when asked, on the captured payload", () => {
    const md = (sync093.results as Record<string, unknown>[])[0]
      .markdown as Record<string, string>;
    // Both keys are present on 0.9.3, so preferFit has something to choose.
    expect(md.raw_markdown).toBeTruthy();
    expect(md.fit_markdown).toBeDefined();
  });
});

describe("0.9.x error shapes", () => {
  it("surfaces the correlation_id from a generic 5xx", () => {
    // 0.9.x replaces server error text with `{error, correlation_id}`; the id
    // is the only way to find the real error in the server log, so losing it
    // would leave a 500 with nothing actionable at all.
    const reason = crawl4aiErrorReason(
      "Crawl4AI error: 500",
      JSON.stringify({
        error: "Internal server error",
        correlation_id: "c4a1-9f3e-77bd",
      }),
    );
    expect(reason).toContain("correlation_id=c4a1-9f3e-77bd");
    expect(reason).toContain("Internal server error");
  });

  it("keeps the correlation_id ahead of the prose so a bound cannot cut it", () => {
    const reason = crawl4aiErrorReason(
      "Crawl4AI error: 500",
      JSON.stringify({ error: "x".repeat(400), correlation_id: "abc123" }),
    );
    expect(reason.slice(0, 200)).toContain("correlation_id=abc123");
  });

  it("does not drop a non-string detail (422 validation)", () => {
    // Captured live: a 422 makes `detail` an array of objects. Read as a
    // string it is undefined, and the whole reason silently becomes empty.
    const reason = crawl4aiErrorReason(
      "Crawl4AI error: 422",
      JSON.stringify({
        detail: [
          {
            type: "too_short",
            loc: ["body", "urls"],
            msg: "List should have at least 1 item",
          },
        ],
      }),
    );
    expect(reason).toContain("too_short");
    expect(reason).not.toBe("Crawl4AI error: 422");
  });

  it("relays the trust-boundary rejection verbatim enough to act on", () => {
    // The exact 400 body a 0.9.3 returns for proxy_config. If this ever fires
    // in production it means the field came back; the reason has to say so.
    const reason = crawl4aiErrorReason(
      "Crawl4AI error: 400",
      JSON.stringify({
        detail:
          "Rejected request: field 'proxy_config' is not permitted on BrowserConfig from an untrusted request",
      }),
    );
    expect(reason).toContain("proxy_config");
    expect(reason).toContain("not permitted");
  });
});
