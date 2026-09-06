import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/domain-db.js", () => ({
  recordRobotsProbe: vi.fn().mockResolvedValue(undefined),
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import { recordRobotsProbe } from "../src/domain-db.js";
import { checkRobots } from "../src/robots.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);
const recordRobotsProbeMock = vi.mocked(recordRobotsProbe);

describe("checkRobots", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows when origin returns no robots.txt", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 404 }) as Response,
    );
    const result = await checkRobots("https://example.com/page", "searxng-mcp");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_robots_txt");
  });

  it("disallows when robots.txt blocks the user-agent", async () => {
    const body = `User-agent: searxng-mcp\nDisallow: /private/\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/private/secret",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("disallowed");
  });

  it("allows paths not covered by Disallow", async () => {
    const body = `User-agent: searxng-mcp\nDisallow: /private/\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/public",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(true);
  });

  it("applies User-agent: * when no specific match", async () => {
    const body = `User-agent: *\nDisallow: /\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/anything",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(false);
  });

  it("allows on malformed URL input rather than throwing", async () => {
    const result = await checkRobots("not-a-url", "searxng-mcp");
    expect(result.allowed).toBe(true);
  });

  it("caches a fresh fetch result", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("User-agent: *\nAllow: /\n", { status: 200 }) as Response,
    );
    await checkRobots("https://example.com/x", "searxng-mcp");
    expect(cacheSetMock).toHaveBeenCalled();
    const [, _value, ttl] = cacheSetMock.mock.calls[0];
    expect(ttl).toBe(24 * 60 * 60);
  });
});

/**
 * `fetchRobotsTxt` returned `{body: null}` for four different situations — a
 * 404, a 5xx, a missing response body, and a transport failure — and
 * `checkRobots` turned all four into `allowed: true, reason: "no_robots_txt"`.
 *
 * Three consequences, in increasing order of seriousness:
 *   1. an investigator cannot tell a permissive site from an unreachable one
 *   2. the answer was cached for 24 HOURS, so one bad five-second window
 *      asserted for a day that a site had no crawl rules
 *   3. `recordRobotsProbe(origin, false, true)` wrote that into the domain
 *      database as a fact about a third party's site
 *
 * The permissive default is deliberate and unchanged: failing closed would
 * stop crawling on every transient blip. What changes is that it is no longer
 * indistinguishable from consent.
 */
describe("checkRobots distinguishes unreachable from permissive", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    recordRobotsProbeMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a transport failure as unreachable, not as an absent robots.txt", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    );
    const result = await checkRobots("https://example.com/page", "searxng-mcp");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("robots_unreachable");
    expect(result.reason).not.toBe("no_robots_txt");
  });

  it("reports a 5xx as unreachable — a 503 is not permission", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 503 }) as Response,
    );
    const result = await checkRobots("https://example.com/page", "searxng-mcp");
    expect(result.reason).toBe("robots_unreachable");
  });

  it("does not record a domain-db capability from a failure", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("fetch failed"));
    await checkRobots("https://example.com/page", "searxng-mcp");
    expect(recordRobotsProbeMock).not.toHaveBeenCalled();
  });

  it("still records the capability for a genuine 404", async () => {
    // The negative control. If the guard above were simply suppressing every
    // probe, this would fail — and the fix would have replaced one wrong
    // record with no records at all.
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 404 }) as Response,
    );
    const result = await checkRobots("https://example.com/page", "searxng-mcp");
    expect(result.reason).toBe("no_robots_txt");
    expect(recordRobotsProbeMock).toHaveBeenCalledWith(
      "https://example.com",
      false,
      true,
    );
  });

  it("caches a failure briefly and a real answer for a day", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("fetch failed"));
    await checkRobots("https://example.com/page", "searxng-mcp");
    const failureTtl = cacheSetMock.mock.calls[0]?.[2];

    cacheSetMock.mockClear();
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 404 }) as Response,
    );
    await checkRobots("https://other.example.com/page", "searxng-mcp");
    const answerTtl = cacheSetMock.mock.calls[0]?.[2];

    expect(answerTtl).toBe(24 * 60 * 60);
    expect(failureTtl).toBeLessThan(answerTtl as number);
  });
});
