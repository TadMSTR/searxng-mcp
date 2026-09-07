// normalizeSearxMeta collapses SearXNG's version-varying answer/infobox shapes
// into one contract.
//
// The shapes differ BY SEARXNG VERSION and by which engine answered, so an
// adopter running a different SearXNG than the one this was written against
// hits these branches on day one. Everything that survives here is rendered to
// the caller as fact, which is why the empty-entry filters matter: an infobox
// with no title and no content renders as a blank bullet that reads like a
// missing value rather than an absent one.
import { describe, expect, it } from "vitest";
import { normalizeSearxMeta } from "../src/search.js";
import type { SearxResponse } from "../src/types.js";

// SearXNG's answers/infoboxes/corrections shapes vary BY VERSION, and feeding
// normalizeSearxMeta the shapes a real instance emits is the whole point of
// these tests — including shapes `SearxResponse` does not model. One narrow
// cast lives here rather than an `as any` at every call site.
type LooseResponse = Record<string, unknown>;
const res = (over: LooseResponse = {}): SearxResponse =>
  ({ results: [], ...over }) as unknown as SearxResponse;

describe("normalizeSearxMeta — answers", () => {
  it("accepts a bare string answer", () => {
    expect(normalizeSearxMeta(res({ answers: ["42"] })).answers).toEqual([
      { answer: "42" },
    ]);
  });

  it("accepts the object form, preferring `answer` over `content`", () => {
    const m = normalizeSearxMeta(
      res({
        answers: [
          { answer: "from answer", content: "from content", url: "https://r" },
        ],
      }),
    );
    expect(m.answers).toEqual([{ answer: "from answer", url: "https://r" }]);
  });

  it("falls back to `content` when `answer` is absent", () => {
    // Newer SearXNG moved the text to `content`; without this fallback every
    // direct answer from such an instance is silently dropped.
    const m = normalizeSearxMeta(
      res({ answers: [{ content: "from content" }] }),
    );
    expect(m.answers).toEqual([{ answer: "from content", url: undefined }]);
  });

  it("drops entries that are empty or whitespace-only under either key", () => {
    const m = normalizeSearxMeta(
      res({
        answers: ["", "   ", { answer: "" }, { content: "  " }, {}, "real"],
      }),
    );
    expect(m.answers).toEqual([{ answer: "real" }]);
  });

  it("defaults to [] when the key is absent", () => {
    expect(normalizeSearxMeta(res()).answers).toEqual([]);
  });
});

describe("normalizeSearxMeta — infoboxes", () => {
  it("maps infobox/content/urls[0] into the flat shape", () => {
    const m = normalizeSearxMeta(
      res({
        infoboxes: [
          {
            infobox: "Debian",
            content: "an OS",
            urls: [{ url: "https://debian.org" }, { url: "https://other" }],
          },
        ],
      }),
    );
    expect(m.infoboxes).toEqual([
      { title: "Debian", content: "an OS", url: "https://debian.org" },
    ]);
  });

  it("keeps an infobox with only a title, or only content", () => {
    const m = normalizeSearxMeta(
      res({
        infoboxes: [{ infobox: "Title only" }, { content: "Content only" }],
      }),
    );
    expect(m.infoboxes).toEqual([
      { title: "Title only", content: "", url: undefined },
      { title: "", content: "Content only", url: undefined },
    ]);
  });

  it("drops an infobox that is empty on BOTH fields", () => {
    const m = normalizeSearxMeta(
      res({
        infoboxes: [{}, { infobox: "  ", content: "  " }, { infobox: "keep" }],
      }),
    );
    expect(m.infoboxes).toEqual([
      { title: "keep", content: "", url: undefined },
    ]);
  });

  it("leaves url undefined when urls is absent or empty", () => {
    const m = normalizeSearxMeta(
      res({ infoboxes: [{ infobox: "A", urls: [] }, { infobox: "B" }] }),
    );
    expect(m.infoboxes.map((i) => i.url)).toEqual([undefined, undefined]);
  });
});

describe("normalizeSearxMeta — corrections and suggestions", () => {
  it("accepts corrections as strings or as {title} objects", () => {
    const m = normalizeSearxMeta(
      res({ corrections: ["debian", { title: "trixie" }] }),
    );
    expect(m.corrections).toEqual(["debian", "trixie"]);
  });

  it("drops empty corrections in either form", () => {
    const m = normalizeSearxMeta(
      res({
        corrections: ["", "  ", {}, { title: "" }, { title: "keep" }],
      }),
    );
    expect(m.corrections).toEqual(["keep"]);
  });

  it("keeps only non-empty string suggestions", () => {
    const m = normalizeSearxMeta(
      res({ suggestions: ["a", "", "  ", 42, null, { s: 1 }, "b"] }),
    );
    expect(m.suggestions).toEqual(["a", "b"]);
  });

  it("returns the fully-empty shape for a response carrying no meta at all", () => {
    expect(normalizeSearxMeta(res())).toEqual({
      answers: [],
      infoboxes: [],
      corrections: [],
      suggestions: [],
    });
  });
});
