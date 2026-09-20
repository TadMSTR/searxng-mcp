// Section extraction from an llms-full.txt document.
//
// This is the fast path that serves documentation sites before the fetch
// cascade runs, so a wrong section is worse than no section: the caller gets
// confident, well-formed content about the wrong page and no signal that it
// missed. The two strategies have different failure modes and extractSection
// falls back from the first to the second, so both need their own cases plus
// the boundary between them.
import { describe, expect, it } from "vitest";
import { extractSection, isLlmsTxtDomain } from "../src/llms-txt.js";

describe("isLlmsTxtDomain", () => {
  const list = ["docs.example.com", "example.org"];

  it("matches an exact host, a subdomain, and a www-prefixed host", () => {
    expect(isLlmsTxtDomain("https://docs.example.com/a", list)).toBe(true);
    expect(isLlmsTxtDomain("https://api.docs.example.com/a", list)).toBe(true);
    expect(isLlmsTxtDomain("https://www.example.org/a", list)).toBe(true);
  });

  it("does not match an unrelated host or a suffix collision", () => {
    expect(isLlmsTxtDomain("https://other.com/a", list)).toBe(false);
    // "notexample.org" must not match "example.org" — the guard is
    // `endsWith("." + pat)`, not a bare endsWith.
    expect(isLlmsTxtDomain("https://notexample.org/a", list)).toBe(false);
  });

  it("returns false for an empty allowlist and for an unparseable URL", () => {
    expect(isLlmsTxtDomain("https://docs.example.com/a", [])).toBe(false);
    expect(isLlmsTxtDomain("not-a-url", list)).toBe(false);
  });
});

describe("extractSection — URL: line strategy", () => {
  const DOC = [
    "# Site docs",
    "",
    "---",
    "URL: https://docs.example.com/intro",
    "# Introduction",
    "Intro body text.",
    "",
    "---",
    "URL: https://docs.example.com/guide",
    "# Guide",
    "Guide body text.",
    "",
    "---",
    "URL: https://docs.example.com/api",
    "# API",
    "API body text.",
  ].join("\n");

  it("returns the requested page and only that page", () => {
    const s = extractSection(DOC, "https://docs.example.com/guide");
    expect(s).not.toBeNull();
    expect(s?.title).toBe("Guide");
    expect(s?.text).toContain("Guide body text.");
    // The neighbours must not bleed in — this is the assertion that a naive
    // "split on ---" would fail on a page containing its own separators.
    expect(s?.text).not.toContain("Intro body text.");
    expect(s?.text).not.toContain("API body text.");
  });

  it("returns the LAST page, running to end of file", () => {
    const s = extractSection(DOC, "https://docs.example.com/api");
    expect(s?.title).toBe("API");
    expect(s?.text).toContain("API body text.");
    expect(s?.text).not.toContain("Guide body text.");
  });

  it("returns the FIRST page, with no preceding separator to walk back to", () => {
    const s = extractSection(DOC, "https://docs.example.com/intro");
    expect(s?.title).toBe("Introduction");
    expect(s?.text).toContain("Intro body text.");
    expect(s?.text).not.toContain("Guide body text.");
  });

  it("ignores a trailing slash on either side", () => {
    expect(extractSection(DOC, "https://docs.example.com/guide/")?.title).toBe(
      "Guide",
    );
  });

  it("matches across hosts by path suffix", () => {
    // Anthropic serves docs.anthropic.com/<path> while its llms-full.txt lists
    // platform.claude.com/docs/<path>. A host-equality check would miss every
    // page on such a site.
    //
    // The delimiter here is LOWERCASE, and that is the point. This fixture used
    // to write "URL:" — describing the real Anthropic document accurately in
    // prose while using a spelling that document has never emitted. It passed,
    // and the cross-host logic it exercises was genuinely correct, so nothing
    // looked wrong; meanwhile the case-sensitive regex meant the path was dead
    // in production for every Anthropic page (vikunja#640). A fixture that
    // disagrees with the source it stands in for tests the matcher against a
    // world that does not exist.
    const doc = [
      "---",
      "url: https://platform.claude.com/docs/build/agents",
      "# Agents",
      "Body.",
    ].join("\n");
    expect(
      extractSection(doc, "https://docs.anthropic.com/build/agents")?.title,
    ).toBe("Agents");
  });

  it("accepts the page delimiter in either case", () => {
    // `url:` is what the YAML front-matter in a generated llms-full.txt writes;
    // `URL:` is what older documents wrote. Both must resolve, and neither
    // spelling may change WHICH page is returned.
    for (const key of ["url", "URL", "Url"]) {
      const doc = [
        "---",
        `${key}: https://docs.example.com/alpha`,
        "# Alpha",
        "Alpha body.",
        "",
        "---",
        `${key}: https://docs.example.com/beta`,
        "# Beta",
        "Beta body.",
      ].join("\n");
      const s = extractSection(doc, "https://docs.example.com/beta");
      expect(s?.title, `delimiter spelled ${key}:`).toBe("Beta");
      expect(s?.text).toContain("Beta body.");
      expect(s?.text).not.toContain("Alpha body.");
    }
  });

  it("extracts from the real front-matter shape the Anthropic document uses", () => {
    // Reduced from the live platform.claude.com/llms-full.txt, 2026-09-20 — a
    // `## <title>` heading, then a `---` fenced block carrying title/url/
    // description, then the body. Measured there: 629 `url:` lines, 0 `URL:`
    // lines, and 0 `## [title](url)` heading links, so BOTH extractors returned
    // null for every input and the fast path could not hit.
    const doc = [
      "# Anthropic Developer Documentation - Full Content",
      "",
      "## Docs home",
      "",
      "---",
      "title: Documentation",
      "url: https://platform.claude.com/docs/en/home",
      "description: Claude API Documentation",
      "---",
      "",
      "Home body.",
      "",
      "## Messages",
      "",
      "---",
      "title: Messages",
      "url: https://platform.claude.com/docs/en/api/messages",
      "description: Send a message",
      "---",
      "",
      "Messages body.",
    ].join("\n");

    const home = extractSection(
      doc,
      "https://platform.claude.com/docs/en/home",
    );
    expect(home?.text).toContain("Home body.");
    expect(home?.text).not.toContain("Messages body.");

    // And the same document reached via the legacy host, which 302s to
    // platform.claude.com but whose path lacks the /docs prefix.
    const legacy = extractSection(
      doc,
      "https://docs.anthropic.com/en/api/messages",
    );
    expect(legacy?.text).toContain("Messages body.");
    expect(legacy?.text).not.toContain("Home body.");
  });

  it("still returns null for a page the document does not contain", () => {
    // The control for the three cases above. Without it, a delimiter change that
    // made everything match would look identical to one that made the right
    // thing match.
    const doc = [
      "---",
      "url: https://platform.claude.com/docs/en/home",
      "# Home",
      "Home body.",
    ].join("\n");
    expect(
      extractSection(doc, "https://platform.claude.com/docs/en/no-such-page"),
    ).toBeNull();
  });

  it("returns null when no URL: line matches the requested path", () => {
    expect(extractSection(DOC, "https://docs.example.com/nope")).toBeNull();
  });

  it("skips a malformed URL: line rather than abandoning the search", () => {
    // A single bad line inside a document must not cost the pages after it.
    const doc = [
      "---",
      "URL: ::::not a url::::",
      "# Broken",
      "Broken body.",
      "",
      "---",
      "URL: https://docs.example.com/good",
      "# Good",
      "Good body.",
    ].join("\n");
    const s = extractSection(doc, "https://docs.example.com/good");
    expect(s?.title).toBe("Good");
    expect(s?.text).toContain("Good body.");
  });

  it("returns a section with no title when the page has no h1", () => {
    const doc = [
      "---",
      "URL: https://docs.example.com/x",
      "Just body, no heading.",
    ].join("\n");
    const s = extractSection(doc, "https://docs.example.com/x");
    expect(s).not.toBeNull();
    expect(s?.title).toBeUndefined();
    expect(s?.text).toContain("Just body, no heading.");
  });
});

describe("extractSection — heading-link fallback", () => {
  const DOC = [
    "# Index",
    "",
    "## [Getting started](/start)",
    "Start body.",
    "",
    "### [Nested](/start/nested)",
    "Nested body.",
    "",
    "## [Reference](/reference)",
    "Reference body.",
  ].join("\n");

  it("is used when there are no URL: lines at all", () => {
    const s = extractSection(DOC, "https://docs.example.com/reference");
    expect(s?.title).toBe("Reference");
    expect(s?.text).toContain("Reference body.");
    expect(s?.text).not.toContain("Start body.");
  });

  it("a section ends at the next heading of the SAME OR SHALLOWER level", () => {
    // "## [Getting started]" must swallow its "### [Nested]" child but stop at
    // the next "##". Ending at any heading would truncate; ending only at the
    // same level would run past the sibling.
    const s = extractSection(DOC, "https://docs.example.com/start");
    expect(s?.title).toBe("Getting started");
    expect(s?.text).toContain("Start body.");
    expect(s?.text).toContain("Nested body.");
    expect(s?.text).not.toContain("Reference body.");
  });

  it("a deeper section stops at its own level", () => {
    const s = extractSection(DOC, "https://docs.example.com/start/nested");
    expect(s?.title).toBe("Nested");
    expect(s?.text).toContain("Nested body.");
    expect(s?.text).not.toContain("Reference body.");
  });

  it("runs to end of file for the last heading", () => {
    const doc = ["# I", "", "## [Only](/only)", "Only body."].join("\n");
    expect(
      extractSection(doc, "https://docs.example.com/only")?.text,
    ).toContain("Only body.");
  });

  it("returns null when nothing matches under either strategy", () => {
    expect(extractSection(DOC, "https://docs.example.com/absent")).toBeNull();
    expect(extractSection("", "https://docs.example.com/x")).toBeNull();
    expect(
      extractSection("no structure at all", "https://docs.example.com/x"),
    ).toBeNull();
  });
});
