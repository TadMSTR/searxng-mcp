// Property-based tests for the extractor layer.
//
// These functions run on ATTACKER-INFLUENCED input by definition: the HTML
// comes from whatever page the caller asked for, and `fetch_url` accepts an
// arbitrary URL. So the contract they have to hold is a total one — never
// throw, always return the declared shape — because a throw here does not
// degrade the fetch cascade, it aborts it.
//
// Generating "valid HTML" would test the happy path the example tests already
// cover. The generators below deliberately produce malformed, truncated,
// deeply-nested and hostile markup instead, because jsdom's tolerance for those
// is the thing actually being relied on.
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractJsonLdArticle, scanJsonLd } from "../src/extractors/jsonld.js";
import { postExtract } from "../src/extractors/post-extract.js";
import {
  preferReadability,
  runReadability,
} from "../src/extractors/readability.js";
import { extractTitle } from "../src/extractors/title.js";

// Hostile-ish HTML. Not "random bytes" — that mostly exercises jsdom's
// tokeniser and tells us little. This aims at the shapes a real page can take
// once a third-party script has been at it: unclosed tags, duplicated meta,
// nested scripts, JSON-LD that is nearly-but-not-quite what we expect.
const tagName = fc.constantFrom(
  "div",
  "span",
  "p",
  "article",
  "section",
  "head",
  "body",
  "title",
  "script",
  "meta",
  "h1",
  "a",
  "table",
  "tr",
  "td",
  "template",
  "svg",
);

const attr = fc.tuple(
  fc.constantFrom("property", "name", "content", "type", "href", "class", "id"),
  fc.string({ maxLength: 40 }),
);

const fragment: fc.Arbitrary<string> = fc.letrec((tie) => ({
  node: fc.oneof(
    { maxDepth: 5, withCrossShrink: true },
    fc.string({ maxLength: 60 }),
    fc
      .tuple(tagName, fc.array(attr, { maxLength: 3 }), tie("node"))
      .map(([t, attrs, inner]) => {
        const a = attrs
          .map(([k, v]) => ` ${k}="${v.replace(/"/g, "")}"`)
          .join("");
        // Half the time, leave the tag unclosed.
        return `<${t}${a}>${inner}`.length % 2 === 0
          ? `<${t}${a}>${inner}</${t}>`
          : `<${t}${a}>${inner}`;
      }),
    // JSON-LD blocks that are plausible but not necessarily well-formed.
    //
    // The `articleBody` arms are NOT decoration. postExtract only reports
    // `source: "json_ld"` when the body clears MIN_JSONLD_BODY_CHARS (300), and
    // a first version of this generator emitted only short or truncated bodies:
    // instrumenting it over 400 runs showed JSON-LD present on 132 of them and
    // `source === "json_ld"` on ZERO. The implication test at the bottom of this
    // file was passing because its antecedent never held once.
    fc
      .oneof(
        fc.constant('{"@type":"Article"}'),
        fc.constant('{"@type":"Article","articleBody":'),
        fc.constant('[{"@graph":[{"@type":"Article"}]}]'),
        fc.constant("{"),
        fc.constant("null"),
        fc.json(),
        // Substantive bodies, above and below the 300-char threshold, so both
        // sides of that boundary are exercised.
        fc
          .tuple(
            fc.integer({ min: 100, max: 900 }),
            fc.string({ maxLength: 60 }),
          )
          .map(([n, title]) =>
            JSON.stringify({
              "@type": "Article",
              headline: title,
              articleBody: "sentence of body text. "
                .repeat(Math.ceil(n / 23))
                .slice(0, n),
            }),
          ),
        fc.integer({ min: 100, max: 900 }).map((n) =>
          JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage" },
              {
                "@type": "Article",
                articleBody: "x y z ".repeat(Math.ceil(n / 6)).slice(0, n),
              },
            ],
          }),
        ),
      )
      .map((j) => `<script type="application/ld+json">${j}</script>`),
  ),
})).node;

const html = fc
  .array(fragment, { maxLength: 6 })
  .map((parts) => parts.join(""));

const url = fc.oneof(
  fc.webUrl(),
  fc.constant("https://example.com/a"),
  fc.constant("https://example.com/"),
);

function domOf(h: string, u: string): JSDOM | null {
  try {
    return new JSDOM(h, { url: u });
  } catch {
    // A jsdom construction failure is not what is under test here — the
    // extractors are only ever handed a DOM that was built successfully.
    return null;
  }
}

describe("extractTitle — total, and always a non-empty string", () => {
  it("never throws and always returns a non-empty string", () => {
    fc.assert(
      fc.property(html, url, (h, u) => {
        const dom = domOf(h, u);
        if (!dom) return;
        const title = extractTitle(dom, u);
        expect(typeof title).toBe("string");
        // The cascade's documented last resort is the URL, so an empty string
        // is never a legal answer.
        expect(title.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic — the same DOM twice gives the same title", () => {
    fc.assert(
      fc.property(html, url, (h, u) => {
        const a = domOf(h, u);
        const b = domOf(h, u);
        if (!a || !b) return;
        expect(extractTitle(a, u)).toBe(extractTitle(b, u));
      }),
      { numRuns: 200 },
    );
  });
});

describe("scanJsonLd / extractJsonLdArticle — total, declared shape", () => {
  it("scanJsonLd never throws and returns booleans/strings only", () => {
    fc.assert(
      fc.property(html, url, (h, u) => {
        const dom = domOf(h, u);
        if (!dom) return;
        const scan = scanJsonLd(dom);
        expect(scan).toBeTypeOf("object");
        expect(scan).not.toBeNull();
        expect(typeof scan.present).toBe("boolean");
      }),
      { numRuns: 300 },
    );
  });

  // Both fields on JsonLdArticle are OPTIONAL, and the content field is `text`,
  // not `body`. The first draft of this test asserted `typeof article.body ===
  // "string"` on a field that does not exist, and it went green — because the
  // generator at the time never produced JSON-LD with a substantive articleBody,
  // so `article` was always null and the assertion was never evaluated.
  //
  // Widening the generator made it fail immediately, which is the useful part:
  // the assertion was wrong AND unreachable, and only fixing the reachability
  // exposed the wrongness. `pnpm test` runs `vitest run --typecheck` and would
  // have caught `article.body` as a type error; a bare `vitest run <file>` does
  // not typecheck, which is how it survived the inner loop.
  //
  // The real contract, from scanJsonLd's docstring: `article` is the first node
  // carrying a USABLE headline or articleBody — so a non-null result must have
  // at least one of the two populated, and each present field must be a string.
  it("extractJsonLdArticle returns null or a genuinely populated article", () => {
    fc.assert(
      fc.property(html, url, (h, u) => {
        const dom = domOf(h, u);
        if (!dom) return;
        const article = extractJsonLdArticle(dom);
        if (article === null) return;
        if (article.title !== undefined)
          expect(typeof article.title).toBe("string");
        if (article.text !== undefined)
          expect(typeof article.text).toBe("string");
        // At least one field must be NON-EMPTY. Not "both non-empty": an
        // article with `"headline": ""` and a real articleBody legitimately
        // yields `{ title: "", text: "..." }`, and that is harmless because the
        // single consumer (postExtract) selects with `||`, not `??`, so an
        // empty title falls through to the title cascade. Checked at the call
        // site rather than assumed — an earlier draft of this assertion
        // required every present field to be non-empty and failed on exactly
        // that shape, which was the test being wrong, not the code.
        //
        // What pickArticle actually guarantees is `!headline && !articleBody`
        // returns null, i.e. at least one is truthy.
        expect(
          (article.title?.length ?? 0) > 0 || (article.text?.length ?? 0) > 0,
          "non-null article carried nothing usable in either field",
        ).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // A pure-noise control: the two functions must agree that nothing is there,
  // rather than one of them finding phantom structure.
  it("HTML with no ld+json block is reported absent by both", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.string({ maxLength: 40 }), { maxLength: 5 })
          .map((p) => `<p>${p.join("</p><p>")}</p>`),
        url,
        (h, u) => {
          const dom = domOf(h, u);
          if (!dom) return;
          expect(scanJsonLd(dom).present).toBe(false);
          expect(extractJsonLdArticle(dom)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("runReadability — total", () => {
  it("never throws; returns null or a result with a string text", () => {
    fc.assert(
      fc.property(html, url, (h, u) => {
        const r = runReadability(h, u);
        if (r === null) return;
        expect(typeof r.text).toBe("string");
        if (r.title !== undefined) expect(typeof r.title).toBe("string");
      }),
      { numRuns: 200 },
    );
  });

  it("never throws on a raw arbitrary string as HTML", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => runReadability(s, "https://example.com/")).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("preferReadability — decision table holds for all inputs", () => {
  it("null readability is never preferred", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(preferReadability(null, { text })).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("below the 500-char floor, any readability result wins; above it, only a longer one does", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        (curLen, readLen) => {
          const decision = preferReadability(
            { text: "r".repeat(readLen) },
            { text: "c".repeat(curLen) },
          );
          // Restating the rule independently of the implementation, so a change
          // to either branch is caught rather than mirrored.
          const expected = curLen < 500 ? true : readLen > curLen;
          expect(decision).toBe(expected);
        },
      ),
      { numRuns: 800 },
    );
  });
});

describe("postExtract — total, and honours maxChars", () => {
  it("never throws, always returns the declared shape", () => {
    fc.assert(
      fc.property(
        html,
        url,
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 400 }),
        fc.integer({ min: 1, max: 5000 }),
        (h, u, baselineTitle, baselineText, maxChars) => {
          const r = postExtract({
            url: u,
            html: h,
            baselineTitle,
            baselineText,
            maxChars,
          });
          expect(typeof r.title).toBe("string");
          expect(typeof r.text).toBe("string");
          expect(["json_ld", "baseline"]).toContain(r.source);
          expect(typeof r.jsonLdPresent).toBe("boolean");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the returned text never exceeds maxChars", () => {
    fc.assert(
      fc.property(
        html,
        url,
        fc.string({ maxLength: 4000 }),
        fc.integer({ min: 1, max: 500 }),
        (h, u, baselineText, maxChars) => {
          const r = postExtract({
            url: u,
            html: h,
            baselineTitle: "a baseline title",
            baselineText,
            maxChars,
          });
          expect(r.text.length).toBeLessThanOrEqual(maxChars);
        },
      ),
      { numRuns: 400 },
    );
  });

  // The invariant that makes the empty-headline case above safe. postExtract
  // selects its title with `||`, so an empty JSON-LD headline falls through to
  // the cascade and then to the URL. Changing that `||` to `??` would surface
  // an empty title to callers and no existing test would notice — this one
  // does, and it is generated over the JSON-LD shapes that produce `title: ""`.
  it("never returns an empty title, whatever the page carries", () => {
    fc.assert(
      fc.property(
        html,
        url,
        fc.string({ maxLength: 80 }),
        fc.integer({ min: 1, max: 5000 }),
        (h, u, baselineTitle, maxChars) => {
          const r = postExtract({
            url: u,
            html: h,
            baselineTitle,
            baselineText: "baseline body text",
            maxChars,
          });
          expect(r.title.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  // jsonLdPresent is documented as DISTINCT from source === "json_ld" — the
  // comment in post-extract.ts records that conflating them reported presence
  // on 0 of 111 sampled pages. This pins the one-way implication that must
  // hold: choosing json_ld as the source requires it to be present.
  it("source === 'json_ld' implies jsonLdPresent", () => {
    fc.assert(
      fc.property(
        html,
        url,
        fc.integer({ min: 1, max: 5000 }),
        (h, u, maxChars) => {
          const r = postExtract({
            url: u,
            html: h,
            baselineTitle: "a baseline title",
            baselineText: "baseline body text",
            maxChars,
          });
          if (r.source === "json_ld") expect(r.jsonLdPresent).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
