import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  extractJsonLdArticle,
  scanJsonLd,
} from "../../src/extractors/jsonld.js";

function dom(body: string): JSDOM {
  return new JSDOM(
    `<!doctype html><html><head></head><body>${body}</body></html>`,
  );
}

describe("extractJsonLdArticle", () => {
  it("returns null when no script tags exist", () => {
    expect(extractJsonLdArticle(dom("<p>hello</p>"))).toBeNull();
  });

  it("extracts headline + articleBody from NewsArticle", () => {
    const result = extractJsonLdArticle(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            headline: "The Real Title",
            articleBody: "The body of the article.",
          })}
        </script>
      `),
    );
    expect(result).toEqual({
      title: "The Real Title",
      text: "The body of the article.",
    });
  });

  it("ignores types not in the article set", () => {
    expect(
      extractJsonLdArticle(
        dom(`
          <script type="application/ld+json">
            ${JSON.stringify({
              "@type": "Organization",
              headline: "Nope",
              articleBody: "Nope",
            })}
          </script>
        `),
      ),
    ).toBeNull();
  });

  it("walks @graph entries", () => {
    const result = extractJsonLdArticle(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", name: "Site" },
              {
                "@type": "BlogPosting",
                headline: "Graph Title",
                articleBody: "Graph body",
              },
            ],
          })}
        </script>
      `),
    );
    expect(result?.title).toBe("Graph Title");
    expect(result?.text).toBe("Graph body");
  });

  it("handles Article type with array @type", () => {
    const result = extractJsonLdArticle(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": ["Article", "TechArticle"],
            headline: "Tech Headline",
            articleBody: "Tech body",
          })}
        </script>
      `),
    );
    expect(result?.title).toBe("Tech Headline");
  });

  it("silently skips malformed JSON", () => {
    const result = extractJsonLdArticle(
      dom(`<script type="application/ld+json">{not json}</script>`),
    );
    expect(result).toBeNull();
  });

  it("returns first matching article when multiple blocks exist", () => {
    const result = extractJsonLdArticle(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "Article",
            headline: "First",
            articleBody: "First body",
          })}
        </script>
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "BlogPosting",
            headline: "Second",
            articleBody: "Second body",
          })}
        </script>
      `),
    );
    expect(result?.title).toBe("First");
  });

  it("requires either headline or articleBody to match", () => {
    expect(
      extractJsonLdArticle(
        dom(`
          <script type="application/ld+json">
            ${JSON.stringify({ "@type": "Article" })}
          </script>
        `),
      ),
    ).toBeNull();
  });
});

describe("scanJsonLd presence", () => {
  // Presence must not depend on extractability. The live corpus reported
  // json_ld_article present on 0 of 111 sampled pages precisely because the
  // caller inferred presence from "did JSON-LD supply the body", and almost no
  // site ships a full articleBody.
  it("reports present for headline-only Article with no articleBody", () => {
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: "Metadata only",
            datePublished: "2026-08-19",
          })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
    // Extractable too — headline alone satisfies pickArticle.
    expect(scan.article?.title).toBe("Metadata only");
  });

  it("reports present for an Article node carrying neither headline nor body", () => {
    // The shape the old detector was structurally unable to see: valid Article
    // schema with all its content in fields the extractor doesn't read.
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "Article",
            author: { "@type": "Person", name: "Someone" },
            dateModified: "2026-08-19",
          })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
    expect(scan.article).toBeNull();
  });

  it("reports absent when the page carries only non-article schema", () => {
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "BreadcrumbList",
            itemListElement: [{ "@type": "ListItem", position: 1 }],
          })}
        </script>
      `),
    );
    expect(scan.present).toBe(false);
    expect(scan.article).toBeNull();
  });

  it("finds an Article nested in @graph", () => {
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", name: "Site" },
              { "@type": "BlogPosting", headline: "Nested post" },
            ],
          })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
    expect(scan.article?.title).toBe("Nested post");
  });

  it("matches a fully-qualified schema.org @type URL", () => {
    // `"@type": "https://schema.org/NewsArticle"` is valid JSON-LD and was
    // silently unmatched by a bare-name comparison.
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({
            "@type": "https://schema.org/NewsArticle",
            headline: "Qualified",
          })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
  });

  it("matches Article subtypes beyond the original four", () => {
    for (const type of [
      "ScholarlyArticle",
      "OpinionNewsArticle",
      "LiveBlogPosting",
    ]) {
      const scan = scanJsonLd(
        dom(`
          <script type="application/ld+json">
            ${JSON.stringify({ "@type": type, headline: type })}
          </script>
        `),
      );
      expect(scan.present, `${type} should be recognised`).toBe(true);
    }
  });

  it("keeps scanning later blocks after an extractable article is found", () => {
    // Presence must not short-circuit on the first usable article, or it
    // becomes content-dependent again by the back door.
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">
          ${JSON.stringify({ "@type": "Article", headline: "First" })}
        </script>
        <script type="application/ld+json">
          ${JSON.stringify({ "@type": "NewsArticle", headline: "Second" })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
    expect(scan.article?.title).toBe("First");
  });

  it("survives malformed JSON and reports whatever the valid blocks carry", () => {
    const scan = scanJsonLd(
      dom(`
        <script type="application/ld+json">{ not json </script>
        <script type="application/ld+json">
          ${JSON.stringify({ "@type": "TechArticle", headline: "Valid" })}
        </script>
      `),
    );
    expect(scan.present).toBe(true);
  });

  it("reports absent for a page with no JSON-LD at all", () => {
    expect(scanJsonLd(dom("<p>hello</p>")).present).toBe(false);
  });
});
