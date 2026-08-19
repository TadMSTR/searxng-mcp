import { describe, expect, it } from "vitest";
import {
  classifyContentType,
  looksLikeHtml,
  renderStructured,
} from "../src/content-type.js";

describe("classifyContentType", () => {
  it("classifies the JSON family, including vendor +json subtypes", () => {
    // A bare `application/json` check misses the long tail — api.osv.dev and
    // registry.npmjs.org are plain JSON, but vendor APIs routinely aren't.
    expect(classifyContentType("application/json")).toBe("json");
    expect(classifyContentType("application/json; charset=utf-8")).toBe("json");
    expect(classifyContentType("application/vnd.api+json")).toBe("json");
    expect(classifyContentType("application/ld+json")).toBe("json");
  });

  it("classifies xml, yaml, toml, csv and plain text", () => {
    expect(classifyContentType("application/xml")).toBe("xml");
    expect(classifyContentType("text/xml")).toBe("xml");
    expect(classifyContentType("application/rss+xml")).toBe("xml");
    expect(classifyContentType("application/yaml")).toBe("yaml");
    expect(classifyContentType("text/x-yaml")).toBe("yaml");
    expect(classifyContentType("application/toml")).toBe("toml");
    expect(classifyContentType("text/csv")).toBe("csv");
    expect(classifyContentType("text/plain; charset=utf-8")).toBe("text");
  });

  it("returns null for HTML so pages keep using the browser tiers", () => {
    expect(classifyContentType("text/html")).toBeNull();
    expect(classifyContentType("text/html; charset=utf-8")).toBeNull();
    expect(classifyContentType("application/xhtml+xml")).toBeNull();
  });

  it("returns null for binary and unknown types", () => {
    expect(classifyContentType("application/pdf")).toBeNull();
    expect(classifyContentType("image/png")).toBeNull();
    expect(classifyContentType("application/octet-stream")).toBeNull();
  });

  it("returns null rather than guessing when the header is missing", () => {
    // Fail-open: an unreadable header must leave routing untouched.
    expect(classifyContentType(null)).toBeNull();
    expect(classifyContentType(undefined)).toBeNull();
    expect(classifyContentType("")).toBeNull();
    expect(classifyContentType("   ")).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifyContentType("Application/JSON")).toBe("json");
    expect(classifyContentType("  application/json  ; q=1")).toBe("json");
  });
});

describe("looksLikeHtml", () => {
  it("detects markup regardless of leading whitespace or case", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html>...")).toBe(true);
    expect(looksLikeHtml("\n  <html lang='en'>")).toBe(true);
    expect(looksLikeHtml("<!doctype HTML>")).toBe(true);
  });

  it("does not fire on a document that merely mentions html", () => {
    // Only the opening bytes count — a plain-text file discussing markup is
    // still a plain-text file.
    expect(looksLikeHtml("Notes on <html> and how to write it")).toBe(false);
    expect(looksLikeHtml('{"tag":"<html>"}')).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
  });
});

describe("renderStructured", () => {
  it("pretty-prints and fences minified JSON", () => {
    const out = renderStructured(
      '{"name":"express","version":"5.0.0"}',
      "json",
    );
    expect(out).toBe(
      '```json\n{\n  "name": "express",\n  "version": "5.0.0"\n}\n```',
    );
  });

  it("fences unparseable JSON as-is rather than dropping the body", () => {
    // A truncated response is still worth something to the caller.
    const out = renderStructured('{"name": "trunc', "json");
    expect(out).toBe('```json\n{"name": "trunc\n```');
  });

  it("fences xml/yaml/csv with a language tag and no reformatting", () => {
    expect(renderStructured("<a><b/></a>", "xml")).toBe(
      "```xml\n<a><b/></a>\n```",
    );
    expect(renderStructured("key: value", "yaml")).toBe(
      "```yaml\nkey: value\n```",
    );
    expect(renderStructured("a,b\n1,2", "csv")).toBe("```csv\na,b\n1,2\n```");
  });

  it("returns plain text bare — a fence would only add noise", () => {
    expect(renderStructured("just some text", "text")).toBe("just some text");
  });
});
