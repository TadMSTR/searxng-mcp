// The pure, caller-facing functions in crawl.ts: the manifest renderer and the
// two URL extractors.
//
// These sit at the boundary where a crawl result becomes text an agent reads,
// or where a third party's XML/JSON becomes a list of URLs we will fetch. Both
// are total by contract — a malformed sitemap is a fact about the sitemap, not
// an error — so the interesting cases are all degenerate inputs.
import { describe, expect, it } from "vitest";
import {
  type CrawlManifest,
  extractMapUrls,
  extractSitemapUrls,
  formatCrawlManifest,
} from "../src/crawl.js";

// extractMapUrls is defensive about link shapes because Firecrawl's /map
// response is third-party JSON — the wrong-shaped inputs below are the reason
// those guards exist, so they are typed loosely on purpose rather than cast at
// each call site.
type LooseMapResponse = Parameters<typeof extractMapUrls>[0];
const loose = (v: unknown) => v as LooseMapResponse;

const page = (url: string, title = "T", snippet = "S") => ({
  url,
  title,
  snippet,
});

const manifest = (over: Partial<CrawlManifest> = {}): CrawlManifest => ({
  base_url: "https://example.com",
  strategy: "sitemap",
  page_count: 1,
  pages: [page("https://example.com/a")],
  cached: false,
  ...over,
});

describe("formatCrawlManifest", () => {
  it("an error manifest reports the note and nothing else", () => {
    expect(
      formatCrawlManifest(manifest({ strategy: "error", note: "boom" })),
    ).toBe("Crawl failed: boom");
  });

  it("an error manifest with no note still says something useful", () => {
    // "Crawl failed: undefined" would be the bug this branch exists to avoid.
    expect(
      formatCrawlManifest(manifest({ strategy: "error", note: undefined })),
    ).toBe("Crawl failed: Unknown error");
  });

  it("marks a cached result, and omits the marker otherwise", () => {
    expect(formatCrawlManifest(manifest({ cached: true }))).toContain(
      "(cached)",
    );
    expect(formatCrawlManifest(manifest({ cached: false }))).not.toContain(
      "(cached)",
    );
  });

  it("includes a note when present and adds no blank line when absent", () => {
    expect(formatCrawlManifest(manifest({ note: "partial crawl" }))).toContain(
      "partial crawl",
    );
    const without = formatCrawlManifest(manifest({ note: undefined }));
    expect(without).not.toMatch(/\n\n\n/);
  });

  it("says so plainly when the crawl found nothing", () => {
    const out = formatCrawlManifest(manifest({ pages: [], page_count: 0 }));
    expect(out).toContain("No pages found.");
    // An empty table would read as a rendering failure rather than an empty
    // result, so the table must be absent entirely.
    expect(out).not.toContain("| # | URL |");
  });

  it("still reports the note when there are no pages", () => {
    expect(
      formatCrawlManifest(
        manifest({ pages: [], page_count: 0, note: "robots disallowed" }),
      ),
    ).toContain("robots disallowed");
  });

  it("escapes pipes in every cell so one URL cannot break the table", () => {
    const out = formatCrawlManifest(
      manifest({ pages: [page("https://e.com/a|b", "ti|tle", "snip|pet")] }),
    );
    expect(out).toContain("https://e.com/a\\|b");
    expect(out).toContain("ti\\|tle");
    expect(out).toContain("snip\\|pet");
    // The header row's own pipes are structural and must survive intact.
    expect(out).toContain("| # | URL | Title | Snippet |");
  });

  it("numbers rows from 1", () => {
    const out = formatCrawlManifest(
      manifest({
        pages: [page("https://e.com/1"), page("https://e.com/2")],
        page_count: 2,
      }),
    );
    expect(out).toContain("| 1 | https://e.com/1");
    expect(out).toContain("| 2 | https://e.com/2");
  });
});

describe("extractSitemapUrls", () => {
  it("reads a urlset", () => {
    expect(
      extractSitemapUrls(
        `<urlset><url><loc>https://e.com/a</loc></url><url><loc>https://e.com/b</loc></url></urlset>`,
      ),
    ).toEqual(["https://e.com/a", "https://e.com/b"]);
  });

  it("reads a sitemapindex", () => {
    expect(
      extractSitemapUrls(
        `<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>`,
      ),
    ).toEqual(["https://e.com/s1.xml"]);
  });

  it("drops entries whose loc is not an http(s) URL", () => {
    // A sitemap is third-party input; a `javascript:` or relative loc must not
    // reach the fetcher.
    expect(
      extractSitemapUrls(
        `<urlset><url><loc>javascript:alert(1)</loc></url><url><loc>/relative</loc></url><url><loc>https://e.com/ok</loc></url></urlset>`,
      ),
    ).toEqual(["https://e.com/ok"]);
  });

  it("drops entries with a missing loc rather than emitting an empty string", () => {
    expect(
      extractSitemapUrls(
        `<urlset><url></url><url><loc>https://e.com/ok</loc></url></urlset>`,
      ),
    ).toEqual(["https://e.com/ok"]);
  });

  it("returns [] for malformed XML, empty input, and unrecognised roots", () => {
    for (const xml of [
      "<urlset><url",
      "",
      "not xml at all",
      "<rss><channel/></rss>",
    ]) {
      expect(extractSitemapUrls(xml), JSON.stringify(xml)).toEqual([]);
    }
  });
});

describe("extractMapUrls", () => {
  it("accepts both the bare-string and {url} link shapes", () => {
    expect(
      extractMapUrls({
        links: ["https://e.com/a", { url: "https://e.com/b" }],
      }),
    ).toEqual(["https://e.com/a", "https://e.com/b"]);
  });

  it("returns [] when links is absent or not an array", () => {
    expect(extractMapUrls({})).toEqual([]);
    expect(extractMapUrls(loose({ links: "https://e.com/a" }))).toEqual([]);
    expect(extractMapUrls(loose({ links: null }))).toEqual([]);
  });

  it("skips nulls, wrong-typed entries and non-http URLs", () => {
    expect(
      extractMapUrls(
        loose({
          links: [
            null,
            42,
            { nope: 1 },
            { url: 7 },
            "ftp://e.com/x",
            "https://e.com/ok",
          ],
        }),
      ),
    ).toEqual(["https://e.com/ok"]);
  });
});
