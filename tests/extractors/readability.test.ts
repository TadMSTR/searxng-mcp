import { describe, expect, it } from "vitest";
import {
  preferReadability,
  runReadability,
} from "../../src/extractors/readability.js";

describe("runReadability", () => {
  it("extracts article text from a simple HTML doc", () => {
    const html = `<!doctype html><html><head><title>Test</title></head>
      <body><article><h1>Heading</h1>${"<p>Long body content here. </p>".repeat(50)}</article></body></html>`;
    const result = runReadability(html, "https://example.com/x");
    expect(result).not.toBeNull();
    expect(result?.text.length ?? 0).toBeGreaterThan(0);
  });

  it("returns null on empty HTML", () => {
    expect(runReadability("", "https://example.com/x")).toBeNull();
  });
});

describe("preferReadability", () => {
  it("prefers Readability when baseline is below 500 chars", () => {
    expect(
      preferReadability(
        { text: "extracted body 1234567890".repeat(3) },
        { text: "short baseline" },
      ),
    ).toBe(true);
  });

  it("prefers Readability when its text is longer than baseline", () => {
    expect(
      preferReadability(
        { text: `long readable text ${"x".repeat(2000)}` },
        { text: "medium baseline ".repeat(40) },
      ),
    ).toBe(true);
  });

  it("keeps baseline when Readability output is shorter than a long baseline", () => {
    expect(
      preferReadability(
        { text: "short readable" },
        { text: "very long baseline ".repeat(200) },
      ),
    ).toBe(false);
  });

  it("returns false when Readability returns null", () => {
    expect(preferReadability(null, { text: "any" })).toBe(false);
  });
});
