// crawl_site's Firecrawl phase, versioned — and made visible.
//
// vikunja#644: crawl.ts called /v2/crawl against a v1-only backend, so the
// phase 404'd on every call for the life of the feature. Nothing noticed,
// because the 404 was swallowed into the sitemap fallback and crawl_site kept
// returning healthy-looking manifests. Two defects, tested separately here: the
// wrong path, and the silence that hid it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = { version: "v1" as "v1" | "v2" };

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheClear: vi.fn(),
  fetchCacheKey: vi
    .fn()
    .mockImplementation(
      (url: string) => `fetch:${Buffer.from(url).toString("hex")}`,
    ),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
  getRobotsForOrigin: vi.fn().mockResolvedValue({ body: null, fetched: "" }),
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../src/fetch.js", () => ({
  fetchPage: vi.fn().mockResolvedValue({ title: "T", text: "body text" }),
  assertPublicUrl: vi.fn(),
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn((_n: string, _a: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../src/domain-db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/log.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../src/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/config.js")>(
      "../src/config.js",
    );
  return {
    ...actual,
    FIRECRAWL_URL: "http://fc:3002",
    FIRECRAWL_API_KEY: "test-key",
    // Getter, not a value: firecrawl-api.js reads this through the mocked
    // namespace, so a getter lets one test file drive both versions without
    // re-importing the module graph per case.
    get FIRECRAWL_API_VERSION() {
      return cfg.version;
    },
    CRAWL_BFS_ENABLED: false,
    CRAWL_BFS_MAX_DEPTH: 2,
    FIRECRAWL_CRAWL_POLL_INTERVAL_MS: 5,
    FIRECRAWL_CRAWL_MAX_WAIT_MS: 100,
    CRAWL_MANIFEST_TTL_SECONDS: 21600,
    FETCH_CACHE_TTL_SECONDS: 86400,
  };
});

import { cacheGet, cacheSet } from "../src/cache.js";
import {
  crawlSite,
  extractMapUrls,
  firecrawlCrawl,
  firecrawlMapUrls,
} from "../src/crawl.js";
import { recordTierAttempt } from "../src/domain-db.js";
import { logWarn } from "../src/log.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const recordTierAttemptMock = vi.mocked(recordTierAttempt);
const logWarnMock = vi.mocked(logWarn);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.version = "v1";
  vi.mocked(cacheGet).mockResolvedValue(null);
});

afterEach(() => {
  cfg.version = "v1";
});

const SITE = "https://example.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Every URL the code fetched, in order. */
function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((c) => c[0] as string);
}

describe("firecrawlCrawl targets the configured API version", () => {
  it("starts and polls on /v1 under v1 — the path #644 should always have used", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          data: [
            {
              markdown: "page one",
              metadata: { title: "One", sourceURL: `${SITE}/1` },
            },
          ],
        }),
      );
    const m = await firecrawlCrawl(SITE, 5);
    expect(m?.strategy).toBe("firecrawl");
    expect(fetchedUrls()).toEqual([
      "http://fc:3002/v1/crawl",
      "http://fc:3002/v1/crawl/job1",
    ]);
  });

  it("starts and polls on /v2 under v2", async () => {
    cfg.version = "v2";
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job2" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          data: [
            {
              markdown: "page one",
              metadata: { title: "One", sourceURL: `${SITE}/1` },
            },
          ],
        }),
      );
    const m = await firecrawlCrawl(SITE, 5);
    expect(m?.strategy).toBe("firecrawl");
    expect(fetchedUrls()).toEqual([
      "http://fc:3002/v2/crawl",
      "http://fc:3002/v2/crawl/job2",
    ]);
  });

  it("records a hit against the crawl slot on success", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(json({ status: "completed", data: [] }));
    await firecrawlCrawl(SITE, 5);
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "hit",
      undefined,
    );
  });
});

// Phase 5. Each of these was a bare `return null` before this build.
describe("firecrawlCrawl failures are logged and counted, not swallowed", () => {
  it("records a typed miss on a 404 from crawl start — the #644 failure itself", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Cannot POST", { status: 404 }),
    );
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "start 404",
    );
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("start 404"),
    );
  });

  it("scrubs URL credentials from a start error before logging and storing it", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError(
        "Request cannot be constructed from a URL that includes credentials: http://fc:hunter2@fc:3002/v1/crawl",
      ),
    );
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    const reason = recordTierAttemptMock.mock.calls[0][3] as string;
    expect(reason).toContain("http://<redacted>@fc:3002");
    expect(reason).not.toContain("hunter2");
    expect(logWarnMock.mock.calls.flat().join("\n")).not.toContain("hunter2");
  });

  it("logs the crawl URL on one line", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Cannot POST", { status: 404 }),
    );
    await firecrawlCrawl("https://example.com/a\nFAKE second line", 5);
    const line = logWarnMock.mock.calls.flat().join("");
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("url=https://example.com/a FAKE second line");
  });

  it("returns null, so crawlSite can fall back, when every page is off-host", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          data: [
            {
              markdown: "www page",
              metadata: { sourceURL: "https://www.example.com/1" },
            },
          ],
        }),
      );
    const filter = { host: "example.com", dropped: 0 };
    expect(
      await firecrawlCrawl(SITE, 5, undefined, undefined, filter),
    ).toBeNull();
    expect(filter.dropped).toBe(1);
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "every page off-host (1 dropped)",
    );
  });

  it("keeps the manifest when some pages survive the host filter", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          data: [
            {
              markdown: "a",
              metadata: { sourceURL: "https://www.example.com/1" },
            },
            { markdown: "b", metadata: { sourceURL: `${SITE}/2` } },
          ],
        }),
      );
    const m = await firecrawlCrawl(SITE, 5, undefined, undefined, {
      host: "example.com",
      dropped: 0,
    });
    expect(m?.pages.map((p) => p.url)).toEqual([`${SITE}/2`]);
  });

  it("records a miss when the start response carries no job id", async () => {
    mockFetch.mockResolvedValueOnce(json({ success: true }));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "start returned no job id",
    );
  });

  it("records a miss on a malformed job id rather than interpolating it", async () => {
    mockFetch.mockResolvedValueOnce(json({ success: true, id: "../../etc" }));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "malformed job id",
    );
    // The guard still holds: no second request went out.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("records a miss with the poll status when the job fails", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(json({ status: "failed" }));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "job failed",
    );
  });

  it("records a miss on a non-2xx poll", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      "poll 500",
    );
  });

  it("records a miss when the start request throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      SITE,
      "crawl_firecrawl",
      "miss",
      expect.stringContaining("ECONNREFUSED"),
    );
  });
});

describe("extractMapUrls", () => {
  // Live shape from self-hosted firecrawl 2.11.162: {url} objects with no title,
  // which is NOT the {url, title} the migration plan assumed. Both are accepted
  // so the next shape change is not another silent dead path.
  it("reads the {url} objects the deployed backend actually returns", () => {
    expect(
      extractMapUrls({
        links: [{ url: "https://a.com/1" }, { url: "https://a.com/2" }],
      }),
    ).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("reads bare string links too", () => {
    expect(extractMapUrls({ links: ["https://a.com/1"] })).toEqual([
      "https://a.com/1",
    ]);
  });

  it("keeps the url when a title happens to be present", () => {
    expect(
      extractMapUrls({ links: [{ url: "https://a.com/1", title: "One" }] }),
    ).toEqual(["https://a.com/1"]);
  });

  it("drops non-http and malformed entries", () => {
    expect(
      extractMapUrls({
        links: [
          { url: "javascript:alert(1)" },
          { title: "no url" },
          "ftp://a.com",
          "https://a.com/ok",
        ],
      }),
    ).toEqual(["https://a.com/ok"]);
  });

  it("returns empty when links is absent or not an array", () => {
    expect(extractMapUrls({})).toEqual([]);
    expect(extractMapUrls({ links: "nope" as unknown as string[] })).toEqual(
      [],
    );
  });
});

describe("firecrawlMapUrls", () => {
  it("returns null without a request under v1, where /map does not exist", async () => {
    expect(await firecrawlMapUrls(SITE)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts to /v2/map under v2", async () => {
    cfg.version = "v2";
    mockFetch.mockResolvedValueOnce(
      json({ success: true, links: [{ url: `${SITE}/a` }] }),
    );
    expect(await firecrawlMapUrls(SITE)).toEqual([`${SITE}/a`]);
    expect(fetchedUrls()).toEqual(["http://fc:3002/v2/map"]);
  });

  it("logs a non-2xx from map rather than failing over in silence", async () => {
    cfg.version = "v2";
    mockFetch.mockResolvedValueOnce(new Response("no", { status: 500 }));
    expect(await firecrawlMapUrls(SITE)).toBeNull();
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("map 500"),
    );
  });

  it("logs an empty link set rather than reporting a silent success", async () => {
    cfg.version = "v2";
    mockFetch.mockResolvedValueOnce(json({ success: true, links: [] }));
    expect(await firecrawlMapUrls(SITE)).toBeNull();
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("no links"),
    );
  });
});

describe("crawlSite cascade placement", () => {
  it("uses /v2/map after Firecrawl crawl and before the sitemap parse", async () => {
    cfg.version = "v2";
    mockFetch
      // Firecrawl crawl start fails, so the cascade moves on.
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      // ...to map, which succeeds.
      .mockResolvedValueOnce(
        json({ success: true, links: [{ url: `${SITE}/a` }] }),
      );
    const m = await crawlSite(SITE, 5, true);
    expect(m.strategy).toBe("map");
    expect(m.pages).toEqual([
      { url: `${SITE}/a`, title: "T", snippet: "body text" },
    ]);
    // No sitemap.xml request was ever made — map short-circuited the fallback.
    expect(fetchedUrls().some((u) => u.includes("sitemap"))).toBe(false);
  });

  it("skips the map phase entirely under v1", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("no", { status: 500 })) // crawl start
      .mockResolvedValue(new Response("", { status: 404 })); // sitemap probes
    const m = await crawlSite(SITE, 5, true);
    expect(fetchedUrls().some((u) => u.includes("/map"))).toBe(false);
    expect(m.strategy).toBe("error");
  });
});

// Firecrawl follows only the start URL's subpaths by default, so an explicit
// include_path ("/" for the whole site, or a sibling section) never widened the
// crawl past the start path. v2 gets crawlEntireDomain; v1, where the option
// is unverified, skips the phase for the strategies that honour include_path.
describe("an explicit include_path can widen the Firecrawl crawl", () => {
  /** The JSON body of the crawl-start request. */
  function startBody(): Record<string, unknown> {
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it.each(["/", "/authors"])(
    "sends crawlEntireDomain with include_path %s under v2",
    async (includePath) => {
      cfg.version = "v2";
      mockFetch.mockResolvedValueOnce(new Response("no", { status: 500 }));
      await firecrawlCrawl(`${SITE}/docs`, 5, includePath);
      expect(startBody()).toMatchObject({
        url: `${SITE}/docs`,
        includePaths: [includePath],
        crawlEntireDomain: true,
      });
    },
  );

  it("leaves the default subpath scope alone with no include_path", async () => {
    cfg.version = "v2";
    mockFetch.mockResolvedValueOnce(new Response("no", { status: 500 }));
    await firecrawlCrawl(`${SITE}/docs`, 5);
    expect(startBody()).not.toHaveProperty("crawlEntireDomain");
    expect(startBody()).not.toHaveProperty("includePaths");
  });

  it("never sends crawlEntireDomain under v1", async () => {
    mockFetch.mockResolvedValueOnce(new Response("no", { status: 500 }));
    await firecrawlCrawl(`${SITE}/docs`, 5, "/");
    expect(startBody()).not.toHaveProperty("crawlEntireDomain");
  });

  it("skips the v1 Firecrawl phase when include_path is given", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 404 }));
    await crawlSite(`${SITE}/docs`, 5, true, "/");
    expect(fetchedUrls().some((u) => u.startsWith("http://fc:3002/"))).toBe(
      false,
    );
  });

  it("still runs the v1 Firecrawl phase with no include_path", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 404 }));
    await crawlSite(`${SITE}/docs`, 5, true);
    expect(fetchedUrls()[0]).toBe("http://fc:3002/v1/crawl");
  });
});

// vikunja#719 class: the three Firecrawl error reasons relay upstream error
// text (err.message), and domain_stats shows the last one to callers on a
// single "| last fail: …" line. Each site's reason comes out bounded and on one
// line.
describe("crawl error reasons are bounded and single-line", () => {
  const LONG = `first line\n${"x".repeat(500)}\r\n\tthird line`;

  function lastReason(): string {
    const call = recordTierAttemptMock.mock.calls.at(-1);
    expect(call?.[1]).toBe("crawl_firecrawl");
    return String(call?.[3]);
  }

  function expectBounded(reason: string, prefix: string) {
    expect(reason.startsWith(prefix)).toBe(true);
    expect(reason).not.toMatch(/[\r\n\t]/);
    // 200 chars plus the ellipsis.
    expect(reason.length).toBeLessThanOrEqual(201);
    expect(reason.endsWith("…")).toBe(true);
  }

  it("start error", async () => {
    mockFetch.mockRejectedValueOnce(new Error(LONG));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expectBounded(lastReason(), "start error: first line x");
  });

  it("poll error", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockRejectedValueOnce(new Error(LONG));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expectBounded(lastReason(), "poll error: first line x");
  });

  it("crawl error", async () => {
    mockFetch
      .mockResolvedValueOnce(json({ success: true, id: "job1" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          data: [
            { markdown: "m", metadata: { title: "t", sourceURL: `${SITE}/1` } },
          ],
        }),
      );
    vi.mocked(cacheSet).mockRejectedValueOnce(new Error(LONG));
    expect(await firecrawlCrawl(SITE, 5)).toBeNull();
    expectBounded(lastReason(), "crawl error: first line x");
  });

  it("map phase: the log line is bounded and single-line", async () => {
    cfg.version = "v2";
    mockFetch.mockRejectedValueOnce(new Error(LONG));
    expect(await firecrawlMapUrls(SITE)).toBeNull();
    const line = String(logWarnMock.mock.calls.at(-1)?.[0]);
    expect(line).toMatch(/^crawl_site map phase miss: first line x/);
    expect(line).not.toMatch(/[\r\n\t]/);
    expect(line).toContain("… url=https://example.com");
  });

  it("the log line carries the same bounded reason", async () => {
    mockFetch.mockRejectedValueOnce(new Error(LONG));
    await firecrawlCrawl(SITE, 5);
    const line = String(logWarnMock.mock.calls.at(-1)?.[0]);
    expect(line).not.toMatch(/[\r\n\t]/);
    expect(line).toContain("start error: first line x");
  });
});
