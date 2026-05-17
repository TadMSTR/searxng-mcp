import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractTitle } from "../../src/extractors/title.js";

function dom(head: string, body = ""): JSDOM {
  return new JSDOM(
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  );
}

describe("extractTitle", () => {
  const fallback = "https://example.com/article";

  it("prefers og:title when it is the longest canonical candidate", () => {
    const d = dom(
      `<meta property="og:title" content="OG Title For This Article Page" />
       <meta name="twitter:title" content="TW Title" />
       <title>Short Title - Site</title>`,
      "<h1>H1 Heading</h1>",
    );
    expect(extractTitle(d, fallback)).toBe("OG Title For This Article Page");
  });

  it("falls back to twitter:title when og:title is missing", () => {
    const d = dom(
      `<meta name="twitter:title" content="Twitter Title For The Article" />
       <title>Short Title | Brand</title>`,
    );
    expect(extractTitle(d, fallback)).toBe("Twitter Title For The Article");
  });

  it("strips common suffixes from <title>", () => {
    const d = dom("<title>Article Title — Site Name</title>");
    expect(extractTitle(d, fallback)).toBe("Article Title");
  });

  it("handles vertical bar suffix", () => {
    const d = dom("<title>Real Headline | Publisher</title>");
    expect(extractTitle(d, fallback)).toBe("Real Headline");
  });

  it("falls back to h1 when no title or meta present", () => {
    const d = dom("", "<h1>Main Heading</h1><p>body</p>");
    expect(extractTitle(d, fallback)).toBe("Main Heading");
  });

  it("falls back to URL when nothing else exists", () => {
    const d = dom("");
    expect(extractTitle(d, fallback)).toBe(fallback);
  });

  it("keeps short titles intact when stripped result is too short", () => {
    const d = dom("<title>OK - Site</title>");
    expect(extractTitle(d, fallback)).toBe("OK - Site");
  });
});
