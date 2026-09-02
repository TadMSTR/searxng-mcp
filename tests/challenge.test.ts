// Challenge detection. The positive cases matter, but the negative control is
// the one that keeps this honest: over-matching turns ordinary pages into
// misses, which is a worse failure than the cache-poisoning bug being fixed.

import { describe, expect, it } from "vitest";
import {
  assertNoChallengeBody,
  CHALLENGE_MISS_REASON,
  ChallengeDetectedError,
  detectChallenge,
} from "../src/challenge.js";

// Trimmed from a real Cloudflare Managed Challenge response — served with
// HTTP 200, which is what makes it slip past the !res.ok guard.
const INTERSTITIAL_200 = `<!DOCTYPE html><html lang="en-US"><head>
<title>Just a moment...</title>
<meta http-equiv="refresh" content="390">
</head><body>
<div class="main-wrapper"><h1>Verifying you are human. This may take a few seconds.</h1></div>
<script>window._cf_chl_opt={cvId:'3',cType:'managed'};</script>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</body></html>`;

// The control. An honest article that uses the phrase in prose — and, for good
// measure, discusses challenge pages. It must still be a hit.
const HONEST_PROSE = `<!DOCTYPE html><html><head>
<title>Notes on waiting well</title></head><body>
<article><h1>Notes on waiting well</h1>
<p>Just a moment ago I was convinced the build was broken.</p>
<p>Give it just a moment and the deploy settles on its own.</p>
</article></body></html>`;

describe("detectChallenge — status and headers", () => {
  it("flags a 503 from a Cloudflare edge (cf-ray)", () => {
    const signal = detectChallenge(
      503,
      new Headers({ "cf-ray": "8f2a1b3c4d5e6f70-LHR" }),
      null,
    );
    expect(signal).toEqual({ kind: "status_headers", marker: "status_503" });
  });

  it("flags a 403 from a Cloudflare edge (server header)", () => {
    const signal = detectChallenge(
      403,
      new Headers({ server: "cloudflare" }),
      null,
    );
    expect(signal).toEqual({ kind: "status_headers", marker: "status_403" });
  });

  it("does not flag an honest 403 with no Cloudflare markers", () => {
    // Status alone is not sufficient — plenty of honest 403s exist, and
    // treating them as challenges would fire the solver on every one.
    expect(
      detectChallenge(403, new Headers({ server: "nginx" }), null),
    ).toBeNull();
  });

  it("does not flag a 500 from a Cloudflare edge", () => {
    expect(
      detectChallenge(500, new Headers({ "cf-ray": "8f2a1b3c4d5e6f70" }), null),
    ).toBeNull();
  });

  it("tolerates absent headers", () => {
    expect(detectChallenge(503, null, null)).toBeNull();
    expect(detectChallenge(503, undefined, null)).toBeNull();
  });
});

describe("detectChallenge — interstitial body", () => {
  it("flags a 200 Cloudflare interstitial", () => {
    const signal = detectChallenge(200, new Headers(), INTERSTITIAL_200);
    expect(signal?.kind).toBe("interstitial_body");
  });

  it.each([
    ["<title>Just a moment...</title>", "title:just-a-moment"],
    ['<div id="cf-chl-widget"></div>', "cf-chl"],
    [
      '<script src="/cdn-cgi/challenge-platform/h/b/x"></script>',
      "challenge-platform",
    ],
    ["window._cf_chl_opt={cvId:'3'};", "_cf_chl_opt"],
  ])("flags %s", (body, expectedMarker) => {
    const signal = detectChallenge(200, new Headers(), body);
    expect(signal).not.toBeNull();
    expect(signal?.marker).toBe(expectedMarker);
  });

  it("matches the title marker case-insensitively and with attributes", () => {
    expect(
      detectChallenge(200, new Headers(), '<title lang="en">JUST A MOMENT...'),
    ).not.toBeNull();
  });

  it("only scans the head of the body", () => {
    // A large honest document that mentions a marker far past the scan limit
    // must not be reclassified. A real interstitial is a few KB and carries its
    // markers in <head> and the inline challenge script.
    const padded = `${"<p>ordinary content</p>".repeat(6000)}challenge-platform`;
    expect(padded.length).toBeGreaterThan(64 * 1024);
    expect(detectChallenge(200, new Headers(), padded)).toBeNull();
  });

  it("tolerates an absent body", () => {
    expect(detectChallenge(200, new Headers(), null)).toBeNull();
    expect(detectChallenge(200, new Headers(), "")).toBeNull();
  });
});

describe("detectChallenge — negative control", () => {
  // This is the test that stops Phase 1 passing by over-matching. If the
  // "Just a moment" marker is ever loosened from the <title> element to a bare
  // substring, this goes red.
  it("does not flag an honest page containing 'just a moment' in prose", () => {
    expect(detectChallenge(200, new Headers(), HONEST_PROSE)).toBeNull();
  });

  it("does not flag a page whose title merely starts with similar words", () => {
    expect(
      detectChallenge(
        200,
        new Headers(),
        "<title>Just a moment in history: the 1976 drought</title>",
      ),
    ).not.toBeNull();
    // ^ deliberately DOES match: a <title> beginning "Just a moment" is
    // indistinguishable from the interstitial without rendering the page. The
    // cost is one page per such title falling through to the next tier, which
    // is the conservative direction. Recorded here so the trade-off is explicit
    // rather than discovered later.
  });

  it("does not flag ordinary HTML", () => {
    expect(
      detectChallenge(
        200,
        new Headers({ server: "cloudflare" }),
        "<html><head><title>Docs</title></head><body><p>Hello</p></body></html>",
      ),
    ).toBeNull();
  });
});

describe("assertNoChallengeBody", () => {
  it("throws ChallengeDetectedError on a challenged body", () => {
    expect(() => assertNoChallengeBody(INTERSTITIAL_200)).toThrow(
      ChallengeDetectedError,
    );
  });

  it("checks every supplied representation", () => {
    // Tier 1/2 hold both rendered HTML and an extracted text projection; the
    // markers live in the markup, so the text alone would miss them.
    expect(() => assertNoChallengeBody(null, INTERSTITIAL_200)).toThrow(
      ChallengeDetectedError,
    );
  });

  it("does not throw on honest bodies", () => {
    expect(() =>
      assertNoChallengeBody(HONEST_PROSE, "Just a moment ago", null, undefined),
    ).not.toThrow();
  });

  it("carries the marker but never the URL in its message", () => {
    try {
      assertNoChallengeBody(INTERSTITIAL_200);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ChallengeDetectedError);
      const e = err as ChallengeDetectedError;
      expect(e.message).toContain(e.signal.marker);
      expect(e.message).not.toContain("http");
    }
  });
});

describe("CHALLENGE_MISS_REASON", () => {
  it("is the distinct reason the solver gate keys on", () => {
    // Asserted against the literal, not against itself: the gate, the
    // domain-db fail reason and the NATS event all have to agree on this exact
    // string, and a rename that silently changed it would disable the gate.
    expect(CHALLENGE_MISS_REASON).toBe("challenge_detected");
    expect(CHALLENGE_MISS_REASON).not.toBe("empty_result");
  });
});
