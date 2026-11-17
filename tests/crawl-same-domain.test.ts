// crawl_site same_domain_only, on every strategy.
//
// Until 3.32.0 only bfsCrawl received the flag. Firecrawl, /map and the sitemap
// phase never saw it, so on a deployment with Firecrawl configured the flag did
// nothing in either direction while staying in the cache key and the tool
// description.
//
// true:  every strategy drops URLs whose hostname differs from the start URL's.
// false: served by BFS when it is enabled (each BFS fetch is SSRF-guarded);
//        otherwise the crawl stays on the site and the manifest says so.
// Never: an external-links option in Firecrawl's request body. Firecrawl
//        fetches inside the deployment's network, and crawlSite guards only the
//        start URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = { bfs: false };

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheClear: vi.fn(),
  fetchCacheKey: vi.fn().mockImplementation((url: string) => `fetch:${url}`),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
  getRobotsForOrigin: vi.fn().mockResolvedValue({ body: null, fetched: "" }),
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../src/fetch.js", () => ({
  fetchPage: vi.fn(),
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
    FIRECRAWL_API_VERSION: "v2",
    get CRAWL_BFS_ENABLED() {
      return cfg.bfs;
    },
    CRAWL_BFS_MAX_DEPTH: 2,
    FIRECRAWL_CRAWL_POLL_INTERVAL_MS: 5,
    FIRECRAWL_CRAWL_MAX_WAIT_MS: 200,
    CRAWL_MANIFEST_TTL_SECONDS: 21600,
    FETCH_CACHE_TTL_SECONDS: 86400,
  };
});

import { cacheGet, cacheSet } from "../src/cache.js";
import { crawlSite, keepSameHost } from "../src/crawl.js";
import { fetchPage } from "../src/fetch.js";

const SITE = "https://example.com/";
const ON = ["https://example.com/a", "https://example.com/b"];
const OFF = ["https://other.example.org/x", "https://www.example.com/c"];

type Phase = "crawl" | "map" | "sitemap";

/** Answers for one strategy; every other Firecrawl/sitemap call fails. */
function site(answering: Phase | "none", bfsHtml: Record<string, string> = {}) {
  const urls = [...ON, ...OFF];
  const bodies: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetched.push(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (url === "http://fc:3002/v2/crawl") {
      return answering === "crawl"
        ? Response.json({ success: true, id: "job1" })
        : new Response("", { status: 500 });
    }
    if (url === "http://fc:3002/v2/crawl/job1") {
      return Response.json({
        status: "completed",
        data: urls.map((u) => ({
          markdown: `content of ${u}`,
          metadata: { title: u, sourceURL: u },
        })),
      });
    }
    if (url === "http://fc:3002/v2/map") {
      return answering === "map"
        ? Response.json({ success: true, links: urls })
        : new Response("", { status: 500 });
    }
    if (url === "https://example.com/sitemap.xml" && answering === "sitemap") {
      const body = urls.map((l) => `<url><loc>${l}</loc></url>`).join("");
      return new Response(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }
    if (url in bfsHtml) {
      return new Response(bfsHtml[url], {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return { bodies, fetched };
}

beforeEach(() => {
  vi.clearAllMocks();
  cfg.bfs = false;
  vi.mocked(cacheGet).mockResolvedValue(null);
  vi.mocked(cacheSet).mockResolvedValue(undefined);
  vi.mocked(fetchPage).mockImplementation(async (url: string) => ({
    title: url,
    url,
    text: "content",
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pageUrls = (m: { pages: Array<{ url: string }> }) =>
  m.pages.map((p) => p.url).sort();

describe("keepSameHost", () => {
  it("keeps exact hostname matches and counts the rest", () => {
    const f = { host: "example.com", dropped: 0 };
    expect(keepSameHost([...ON, ...OFF, "not a url"], f)).toEqual(ON);
    expect(f.dropped).toBe(3);
  });

  it("is a no-op without a filter", () => {
    expect(keepSameHost([...ON, ...OFF])).toEqual([...ON, ...OFF]);
  });
});

describe.each<Phase>(["crawl", "map", "sitemap"])(
  "same_domain_only true — %s strategy",
  (phase) => {
    const strategy = phase === "crawl" ? "firecrawl" : phase;

    it("drops off-host URLs and says how many", async () => {
      site(phase);
      const m = await crawlSite(SITE, 20, true);
      expect(m.strategy).toBe(strategy);
      expect(pageUrls(m)).toEqual(ON);
      expect(m.note).toContain(
        "same_domain_only: 2 URL(s) not on example.com were dropped",
      );
    });

    it("keeps them with same_domain_only false (BFS disabled) and notes that off-site links were not followed", async () => {
      site(phase);
      const m = await crawlSite(SITE, 20, false);
      expect(m.strategy).toBe(strategy);
      expect(pageUrls(m)).toEqual([...ON, ...OFF].sort());
      expect(m.note).toContain(
        "same_domain_only=false: off-site links were not followed",
      );
      expect(m.note).toContain("BFS crawling is disabled");
    });
  },
);

describe("Firecrawl request body", () => {
  it.each([true, false])(
    "never carries an external-links option (same_domain_only %s)",
    async (sameDomainOnly) => {
      const { bodies } = site("crawl");
      await crawlSite(SITE, 20, sameDomainOnly);
      const start = bodies.find((b) => b.url === SITE && "limit" in b);
      expect(start).toBeDefined();
      const keys = Object.keys(start ?? {});
      expect(keys.filter((k) => /external/i.test(k))).toEqual([]);
      expect(keys).not.toContain("crawlEntireDomain");
    },
  );

  it("does not cache the content of a dropped page", async () => {
    site("crawl");
    await crawlSite(SITE, 20, true);
    const cachedKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0]);
    for (const u of ON) expect(cachedKeys).toContain(`fetch:${u}`);
    for (const u of OFF) expect(cachedKeys).not.toContain(`fetch:${u}`);
  });
});

describe("same_domain_only false with BFS enabled", () => {
  it("goes straight to BFS, follows an off-site link, and never calls Firecrawl", async () => {
    cfg.bfs = true;
    const { fetched } = site("crawl", {
      "https://example.com/": '<a href="https://other.example.org/x">x</a>',
      "https://other.example.org/x": "<p>no links</p>",
    });
    const m = await crawlSite(SITE, 20, false);
    expect(m.strategy).toBe("bfs");
    expect(pageUrls(m)).toEqual([
      "https://example.com/",
      "https://other.example.org/x",
    ]);
    expect(fetched.some((u) => u.startsWith("http://fc:3002"))).toBe(false);
    // Every page BFS visited went through fetchPage — fetch_url's own guarded
    // path — not a bare fetch.
    expect(
      vi
        .mocked(fetchPage)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(pageUrls(m));
    expect(m.note ?? "").not.toContain("off-site links were not followed");
  });

  it("same_domain_only true with BFS enabled still uses the normal cascade", async () => {
    cfg.bfs = true;
    site("crawl");
    const m = await crawlSite(SITE, 20, true);
    expect(m.strategy).toBe("firecrawl");
    expect(pageUrls(m)).toEqual(ON);
  });
});

describe("failure notes", () => {
  it("an all-failed crawl names the dropped URLs", async () => {
    // Firecrawl and map fail; the sitemap lists only other hosts.
    const urls = OFF;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "https://example.com/sitemap.xml") {
          const body = urls.map((l) => `<url><loc>${l}</loc></url>`).join("");
          return new Response(`<urlset>${body}</urlset>`, { status: 200 });
        }
        return new Response("", { status: 500 });
      }),
    );
    const m = await crawlSite(SITE, 20, true);
    expect(m.strategy).toBe("error");
    expect(m.note).toContain("All crawl strategies failed");
    expect(m.note).toContain("2 URL(s) not on example.com were dropped");
  });
});
