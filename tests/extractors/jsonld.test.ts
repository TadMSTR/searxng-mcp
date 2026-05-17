import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractJsonLdArticle } from "../../src/extractors/jsonld.js";

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
