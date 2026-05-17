import { describe, expect, it } from "vitest";
import { postExtract } from "../../src/extractors/post-extract.js";

const wrap = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("postExtract", () => {
  it("uses JSON-LD articleBody when baseline is short (likely chrome-only)", () => {
    const html = wrap(
      `<title>Some Page</title>
       <script type="application/ld+json">
       ${JSON.stringify({
         "@type": "NewsArticle",
         headline: "Real Article Title",
         articleBody:
           "The actual article body, much longer than the chrome-only baseline content that came back from the tier fetch. ".repeat(
             5,
           ),
       })}
       </script>`,
    );
    const result = postExtract({
      url: "https://example.com/article",
      html,
      baselineTitle: "Some Page",
      baselineText: "Tiny nav-only text",
      maxChars: 8000,
    });
    expect(result.source).toBe("json_ld");
    expect(result.title).toBe("Real Article Title");
    expect(result.text).toContain("actual article body");
  });

  it("keeps baseline when JSON-LD body is too short to be substantive", () => {
    const baseline = "Long baseline text. ".repeat(100);
    const html = wrap(
      `<title>Page</title>
       <script type="application/ld+json">
       ${JSON.stringify({
         "@type": "Article",
         headline: "JSON-LD Title",
         articleBody: "Short JSON-LD body",
       })}
       </script>`,
    );
    const result = postExtract({
      url: "https://example.com/x",
      html,
      baselineTitle: "Baseline Title",
      baselineText: baseline,
      maxChars: 8000,
    });
    expect(result.source).toBe("baseline");
    expect(result.text.length).toBeGreaterThan(100);
  });

  it("falls back to meta title cascade only when baseline title is unusable", () => {
    const html = wrap(
      `<meta property="og:title" content="OG Title Wins" /><title>HTML Title - Site</title>`,
    );
    const result = postExtract({
      url: "https://example.com/p",
      html,
      baselineTitle: "https://example.com/p",
      baselineText: "Tier-supplied body",
      maxChars: 8000,
    });
    expect(result.source).toBe("baseline");
    expect(result.title).toBe("OG Title Wins");
  });

  it("prefers the longest og:title when multiple are injected into head", () => {
    const html = wrap(
      `<meta property="og:title" content="American Express" />
       <meta property="og:title" content="Apple Pay" />
       <meta property="og:title" content="Titan 2 Elite Pro - World's Smallest 5G QWERTY Physical Keyboard Smartphone" />`,
    );
    const result = postExtract({
      url: "https://example.com/p",
      html,
      baselineTitle: "junk",
      baselineText: "Tier-supplied body",
      maxChars: 8000,
    });
    expect(result.title).toContain("Titan 2 Elite Pro");
  });

  it("requires JSON-LD body to be substantive (>= 300 chars) before preferring it", () => {
    const html = wrap(`<script type="application/ld+json">
       ${JSON.stringify({
         "@type": "Article",
         headline: "Short Article",
         articleBody: "Just a short paragraph.",
       })}
       </script>`);
    const result = postExtract({
      url: "https://example.com/p",
      html,
      baselineTitle: "Baseline Title",
      baselineText: "Longer baseline text. ".repeat(100),
      maxChars: 8000,
    });
    expect(result.source).toBe("baseline");
  });

  it("truncates text to maxChars", () => {
    const big = "x".repeat(20000);
    const html = wrap("", `<p>${big}</p>`);
    const result = postExtract({
      url: "https://example.com/p",
      html,
      baselineTitle: "T",
      baselineText: big,
      maxChars: 1000,
    });
    expect(result.text.length).toBe(1000);
  });

  it("does not crash on malformed HTML", () => {
    const result = postExtract({
      url: "https://example.com/p",
      html: "<<<>>>not really html<<<>>>",
      baselineTitle: "T",
      baselineText: "Body",
      maxChars: 8000,
    });
    expect(result.text).toBe("Body");
  });
});
