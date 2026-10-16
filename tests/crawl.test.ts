import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// crawlSite/bfsCrawl pre-resolve hostnames via the SSRF guard — stub DNS to a
// public address so tests don't make real DNS queries. Plain function (not a
// vi.fn) so the test suite's mock resets don't wipe the resolved value.
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
  withSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../src/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/config.js")>(
      "../src/config.js",
    );
  return {
    ...actual,
    FIRECRAWL_URL: "http://localhost:3002",
    FIRECRAWL_API_KEY: "test-key",
    CRAWL_BFS_ENABLED: false,
    CRAWL_BFS_MAX_DEPTH: 2,
    FIRECRAWL_CRAWL_POLL_INTERVAL_MS: 50,
    FIRECRAWL_CRAWL_MAX_WAIT_MS: 500,
    CRAWL_MANIFEST_TTL_SECONDS: 21600,
    FETCH_CACHE_TTL_SECONDS: 86400,
  };
});

import { cacheClear, cacheGet, cacheSet } from "../src/cache.js";
import type { CrawlManifest } from "../src/crawl.js";
import {
  bfsCrawl,
  crawlSite,
  defaultCrawlScope,
  extractSitemapUrls,
  inCrawlScope,
  sitemapCrawl,
} from "../src/crawl.js";
import { fetchPage } from "../src/fetch.js";
import { checkRobots, getRobotsForOrigin } from "../src/robots.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);
const cacheClearMock = vi.mocked(cacheClear);
const checkRobotsMock = vi.mocked(checkRobots);
const getRobotsForOriginMock = vi.mocked(getRobotsForOrigin);
const fetchPageMock = vi.mocked(fetchPage);

beforeEach(() => {
  vi.resetAllMocks();
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(undefined);
  checkRobotsMock.mockResolvedValue({ allowed: true });
  getRobotsForOriginMock.mockResolvedValue({ body: null, fetched: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. Sitemap parser ───────────────────────────────────────────────────────

describe("extractSitemapUrls", () => {
  it("parses valid sitemap.xml", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml);
    expect(urls).toContain("https://example.com/page1");
    expect(urls).toContain("https://example.com/page2");
  });

  it("parses sitemap_index.xml and returns child sitemap locs", () => {
    const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    const locs = extractSitemapUrls(xml);
    expect(locs).toContain("https://example.com/sitemap1.xml");
    expect(locs).toContain("https://example.com/sitemap2.xml");
  });

  it("strips non-http locs", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page</loc></url>
  <url><loc>ftp://example.com/file</loc></url>
  <url><loc></loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml);
    expect(urls).toEqual(["https://example.com/page"]);
  });

  it("returns empty array for malformed XML", () => {
    const urls = extractSitemapUrls("<not valid xml {{");
    expect(urls).toEqual([]);
  });

  it("handles single URL (not wrapped in array by fast-xml-parser by default)", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/only</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml);
    expect(urls).toEqual(["https://example.com/only"]);
  });
});

// ─── 2. BFS deduplication ────────────────────────────────────────────────────

describe("bfsCrawl deduplication", () => {
  it("visits each URL only once even if linked from multiple pages", async () => {
    let callCount = 0;
    fetchPageMock.mockImplementation(async (url: string) => {
      callCount++;
      return { title: `Page ${callCount}`, url, text: "content" };
    });

    vi.spyOn(global, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const _url = typeof input === "string" ? input : input.toString();
        // All pages link to /target — creates duplicate enqueue attempts
        const html = `<html><body><a href="https://example.com/target">link</a><a href="https://example.com/target">dup</a></body></html>`;
        return new Response(html, { status: 200 });
      },
    );

    const manifest = await bfsCrawl("https://example.com/", 10, 2, true);

    // /target should appear at most once
    const urls = manifest.pages.map((p) => p.url);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
});

// ─── 3. same_domain_only filter ─────────────────────────────────────────────

describe("bfsCrawl same_domain_only", () => {
  it("does not enqueue off-domain links when same_domain_only=true", async () => {
    fetchPageMock.mockResolvedValue({
      title: "Home",
      url: "https://example.com/",
      text: "home content",
    });

    vi.spyOn(global, "fetch").mockImplementation(async () => {
      const html = `<html><body>
        <a href="https://example.com/internal">internal</a>
        <a href="https://other.com/external">external</a>
      </body></html>`;
      return new Response(html, { status: 200 });
    });

    const manifest = await bfsCrawl("https://example.com/", 5, 2, true);
    const hosts = manifest.pages.map((p) => new URL(p.url).hostname);
    for (const host of hosts) {
      expect(host).toBe("example.com");
    }
  });
});

// ─── 4. max_pages cap ────────────────────────────────────────────────────────

describe("sitemapCrawl max_pages", () => {
  it("never fetches more than max_pages regardless of sitemap size", async () => {
    // Mock discoverSitemapUrls indirectly via fetch
    vi.spyOn(global, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("robots.txt"))
          return new Response("", { status: 404 });
        if (url.endsWith("sitemap.xml")) {
          const locs = Array.from(
            { length: 50 },
            (_, i) => `<url><loc>https://example.com/page${i}</loc></url>`,
          ).join("\n");
          return new Response(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
            { status: 200, headers: { "Content-Type": "text/xml" } },
          );
        }
        return new Response("", { status: 404 });
      },
    );

    fetchPageMock.mockImplementation(async (url: string) => ({
      title: "Page",
      url,
      text: "content",
    }));

    const manifest = await sitemapCrawl("https://example.com/", 5);
    expect(manifest).not.toBeNull();
    expect(manifest?.page_count).toBeLessThanOrEqual(5);
  });
});

// ─── 5. Manifest cache hit ───────────────────────────────────────────────────

describe("crawlSite manifest cache", () => {
  it("returns cached manifest with cached=true on second call", async () => {
    const stored: CrawlManifest = {
      strategy: "sitemap",
      base_url: "https://example.com/",
      page_count: 2,
      pages: [
        { url: "https://example.com/a", title: "A", snippet: "snippet a" },
        { url: "https://example.com/b", title: "B", snippet: "snippet b" },
      ],
      cached: false,
    };
    cacheGetMock.mockResolvedValue(JSON.stringify(stored));

    const manifest = await crawlSite("https://example.com/", 20, true);

    expect(manifest.cached).toBe(true);
    expect(manifest.strategy).toBe("sitemap");
    expect(manifest.page_count).toBe(2);
    // Should not have called cacheSet (returned from cache)
    expect(cacheSetMock).not.toHaveBeenCalled();
  });
});

// ─── 6. clear_cache "crawl" ──────────────────────────────────────────────────

import { handleClearCache } from "../src/tools.js";

describe("handleClearCache crawl target", () => {
  it("calls cacheClear with crawl:* pattern for target='crawl'", async () => {
    cacheClearMock.mockResolvedValue(3);
    await handleClearCache({ target: "crawl" });
    expect(cacheClearMock).toHaveBeenCalledWith("crawl:*");
    expect(cacheClearMock).not.toHaveBeenCalledWith("search:*");
    expect(cacheClearMock).not.toHaveBeenCalledWith("fetch:*");
  });

  it("clears crawl:* keys when target='all'", async () => {
    cacheClearMock.mockResolvedValue(1);
    await handleClearCache({ target: "all" });
    const patterns = cacheClearMock.mock.calls.map((c) => c[0]);
    expect(patterns).toContain("crawl:*");
    expect(patterns).toContain("search:*");
    expect(patterns).toContain("fetch:*");
  });
});

// ─── 7. Robots.txt respect ───────────────────────────────────────────────────

describe("robots.txt respect", () => {
  it("skips disallowed URLs during batch fetch in sitemapCrawl", async () => {
    vi.spyOn(global, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("robots.txt"))
          return new Response("", { status: 404 });
        if (url.endsWith("sitemap.xml")) {
          return new Response(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/allowed</loc></url>
            <url><loc>https://example.com/blocked</loc></url>
          </urlset>`,
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      },
    );

    checkRobotsMock.mockImplementation(async (url: string) => {
      if (url.includes("blocked"))
        return { allowed: false, reason: "disallowed" as const };
      return { allowed: true };
    });

    fetchPageMock.mockResolvedValue({
      title: "Allowed",
      url: "https://example.com/allowed",
      text: "allowed content",
    });

    const manifest = await sitemapCrawl("https://example.com/", 10);
    expect(manifest).not.toBeNull();
    const urls = manifest?.pages.map((p) => p.url);
    expect(urls).not.toContain("https://example.com/blocked");
    expect(urls).toContain("https://example.com/allowed");
  });
});

// ─── Default scope: the start URL's path ─────────────────────────────────────

describe("defaultCrawlScope", () => {
  it.each([
    ["https://valkey.io", undefined],
    ["https://valkey.io/", undefined],
    ["https://valkey.io/index.html", undefined],
    ["https://valkey.io/docs", "/docs"],
    ["https://valkey.io/docs/", "/docs"],
    ["https://valkey.io/docs/index.html", "/docs"],
    ["https://valkey.io/docs/topics/persistence", "/docs/topics/persistence"],
  ])("%s → %s", (url, scope) => {
    expect(defaultCrawlScope(url)).toBe(scope);
  });
});

describe("inCrawlScope", () => {
  it("matches the scope path and anything below it", () => {
    expect(inCrawlScope("https://x.io/docs", "/docs")).toBe(true);
    expect(inCrawlScope("https://x.io/docs/a/b", "/docs")).toBe(true);
  });

  it("does not match a sibling that only shares the prefix, or a deeper match", () => {
    expect(inCrawlScope("https://x.io/docs-old/a", "/docs")).toBe(false);
    expect(inCrawlScope("https://x.io/blog/docs", "/docs")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(inCrawlScope("not a url", "/docs")).toBe(false);
  });
});

// A site whose sitemap lists the home page and other sections ahead of /docs,
// the shape that made an unscoped 5-page crawl of /docs return no docs.
const SCOPE_SITEMAP_LOCS = [
  "https://example.com/",
  "https://example.com/authors/a",
  "https://example.com/authors/b",
  "https://example.com/docs-old/legacy",
  "https://example.com/blog/docs-tips",
  "https://example.com/docs/",
  "https://example.com/docs/install",
  "https://example.com/docs/config",
];

function mockSitemapSite(locs: string[]) {
  vi.spyOn(global, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://example.com/sitemap.xml") {
        const body = locs.map((l) => `<url><loc>${l}</loc></url>`).join("");
        return new Response(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        );
      }
      // robots.txt, Firecrawl and everything else: absent.
      return new Response("", { status: 404 });
    },
  );
  fetchPageMock.mockImplementation(async (url: string) => ({
    title: url,
    url,
    text: "content",
  }));
}

describe("sitemapCrawl scope", () => {
  it("keeps only sitemap URLs under the scope", async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS);
    const manifest = await sitemapCrawl(
      "https://example.com/docs",
      20,
      undefined,
      undefined,
      "/docs",
    );
    expect(manifest?.pages.map((p) => p.url)).toEqual([
      "https://example.com/docs/",
      "https://example.com/docs/install",
      "https://example.com/docs/config",
    ]);
  });
});

describe("crawlSite default scope", () => {
  it("confines a crawl started at /docs to /docs and says so", async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS);
    const manifest = await crawlSite("https://example.com/docs", 5, true);
    expect(manifest.strategy).toBe("sitemap");
    expect(manifest.pages.map((p) => p.url)).toEqual([
      "https://example.com/docs/",
      "https://example.com/docs/install",
      "https://example.com/docs/config",
    ]);
    expect(manifest.note).toContain("Limited to pages under /docs/");
    expect(manifest.note).toContain('include_path "/"');
  });

  it("does not scope a crawl started at the site root", async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS);
    const manifest = await crawlSite("https://example.com/", 20, true);
    expect(manifest.page_count).toBe(SCOPE_SITEMAP_LOCS.length);
    expect(manifest.note).toBeUndefined();
  });

  it('lets include_path "/" opt back into the whole site', async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS);
    const manifest = await crawlSite("https://example.com/docs", 20, true, "/");
    expect(manifest.page_count).toBe(SCOPE_SITEMAP_LOCS.length);
    expect(manifest.note).toBeUndefined();
  });

  it("lets an explicit include_path replace the default scope", async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS);
    const manifest = await crawlSite(
      "https://example.com/docs",
      20,
      true,
      "/authors",
    );
    expect(manifest.pages.map((p) => p.url)).toEqual([
      "https://example.com/authors/a",
      "https://example.com/authors/b",
    ]);
  });

  it("explains an empty scope instead of returning unrelated pages", async () => {
    mockSitemapSite(SCOPE_SITEMAP_LOCS.filter((l) => !l.includes("/docs/")));
    const manifest = await crawlSite("https://example.com/docs", 5, true);
    expect(manifest.strategy).toBe("error");
    expect(manifest.pages).toEqual([]);
    expect(manifest.note).toContain("no sitemap entries under /docs/");
    expect(manifest.note).toContain('include_path "/"');
  });
});

describe("bfsCrawl scope", () => {
  it("does not follow links out of the scope", async () => {
    fetchPageMock.mockImplementation(async (url: string) => ({
      title: url,
      url,
      text: "content",
    }));
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      const html = `<html><body>
        <a href="https://example.com/docs/install">in</a>
        <a href="https://example.com/blog/post">out</a>
        <a href="https://example.com/docs-old/legacy">sibling</a>
      </body></html>`;
      return new Response(html, { status: 200 });
    });
    const manifest = await bfsCrawl(
      "https://example.com/docs",
      10,
      2,
      true,
      undefined,
      undefined,
      "/docs",
    );
    expect(manifest.pages.map((p) => p.url).sort()).toEqual([
      "https://example.com/docs",
      "https://example.com/docs/install",
    ]);
  });
});
