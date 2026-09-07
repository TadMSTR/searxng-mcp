// Degenerate-response coverage for the Reddit and YouTube fast paths.
//
// Both sit in front of the fetch cascade and are best-effort by contract:
// anything they cannot parse must return null so the caller falls through,
// rather than throwing or — worse — returning a half-built result that looks
// like a successful fetch and suppresses the cascade.
//
// The existing reddit.test.ts and youtube.test.ts cover the happy path against
// a well-formed fixture. These are the shapes a rate-limited, logged-out, or
// A/B-tested response actually takes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  REDDIT_FASTPATH_ENABLED: true,
  REDDIT_IGNORE_ROBOTS: false,
  YOUTUBE_TRANSCRIPT_ENABLED: true,
  YOUTUBE_IGNORE_ROBOTS: false,
}));
vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { redditFetch } from "../src/reddit.js";
import { checkRobots } from "../src/robots.js";
import { extractVideoId, youtubeFetch } from "../src/youtube.js";

const THREAD_URL = "https://www.reddit.com/r/homelab/comments/abc123/my_post/";
const checkRobotsMock = vi.mocked(checkRobots);

// The response mock MUST carry a real ReadableStream body.
//
// redditFetch and youtubeFetch read through `readBoundedText`, which does
// `res.body?.getReader()` and returns "" when there is no body — it never
// touches `res.text()`. A `{ text: async () => ..., body: null }` mock
// therefore yields an empty string, JSON.parse throws, and the function returns
// null for EVERY input. A first draft of this file did exactly that: every
// "returns null for <malformed shape>" case below passed while never once
// reaching the parser it claimed to be testing. The two "renders a minimal
// thread" cases are what exposed it, by expecting a non-null result and not
// getting one.
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function res(text: string, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: async () => text,
    body: streamOf(text),
  } as unknown as Response;
}

function jsonRes(body: unknown, status = 200) {
  return res(JSON.stringify(body), status);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  checkRobotsMock.mockResolvedValue({ allowed: true } as never);
  warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("redditFetch — responses that are not a thread", () => {
  it.each([
    ["a bare object instead of the [post, comments] pair", {}],
    ["an array with only one element", [{ data: { children: [] } }]],
    ["an empty array", []],
    ["null", null],
    [
      "a listing whose first child has no post data",
      [{ data: { children: [{}] } }, {}],
    ],
    [
      "a post with no title",
      [{ data: { children: [{ data: { author: "x" } }] } }, {}],
    ],
  ])("returns null for %s", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(body)),
    );
    expect(await redditFetch(THREAD_URL)).toBeNull();
  });

  it("returns null on 429 without throwing — Reddit rate-limits datacenter IPs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({}, 429)),
    );
    expect(await redditFetch(THREAD_URL)).toBeNull();
  });

  it("returns null on any non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({}, 503)),
    );
    expect(await redditFetch(THREAD_URL)).toBeNull();
  });

  it("returns null when the body is not JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res("<html>you are blocked</html>")),
    );
    expect(await redditFetch(THREAD_URL)).toBeNull();
  });

  it("returns null rather than throwing when the request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    expect(await redditFetch(THREAD_URL)).toBeNull();
  });

  it("returns null for an unparseable URL, before any network call", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await redditFetch("not-a-url")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null when robots.txt disallows the path", async () => {
    checkRobotsMock.mockResolvedValue({ allowed: false } as never);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await redditFetch(THREAD_URL)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("redditFetch — a thread carrying only the minimum", () => {
  it("renders a post with no author, subreddit, score, body or comments", async () => {
    // Every optional field absent. The result must still be a usable document
    // rather than a string of "undefined"s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes([
          { data: { children: [{ data: { title: "Bare post" } }] } },
          { data: { children: [] } },
        ]),
      ),
    );
    const r = await redditFetch(THREAD_URL);
    expect(r).not.toBeNull();
    expect(r?.title).toBe("Bare post");
    expect(r?.text).toBe("# Bare post");
    expect(r?.text).not.toMatch(/undefined/);
  });

  it("skips AutoModerator and comments with no body, and defaults a missing score to 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes([
          { data: { children: [{ data: { title: "P", score: 0 } }] } },
          {
            data: {
              children: [
                { data: { author: "AutoModerator", body: "rules" } },
                { data: { author: "nobody" } }, // no body
                { data: { body: "anon comment" } }, // no author
              ],
            },
          },
        ]),
      ),
    );
    const r = await redditFetch(THREAD_URL);
    expect(r?.text).not.toContain("AutoModerator");
    expect(r?.text).toContain("u/? (0 pts): anon comment");
    // score: 0 on the post must still render — a falsy-but-present number is
    // the classic case a truthiness check drops.
    expect(r?.text).toContain("0 pts");
  });

  it("truncates to maxChars", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes([
          {
            data: {
              children: [{ data: { title: "P", selftext: "x".repeat(5000) } }],
            },
          },
          { data: { children: [] } },
        ]),
      ),
    );
    const r = await redditFetch(THREAD_URL, 100);
    expect(r?.text.length).toBe(100);
  });
});

describe("extractVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("%s -> %s", (url, id) => {
    expect(extractVideoId(url)).toBe(id);
  });

  it.each([
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/results?search_query=x",
    "not-a-url",
    "https://www.youtube.com/watch?v=too-short",
    "https://youtu.be/",
  ])("returns null for %s", (url) => {
    expect(extractVideoId(url)).toBeNull();
  });

  it("does NOT check the host — that is isYouTubeHost's job", () => {
    // Worth pinning rather than leaving to be rediscovered: extractVideoId is a
    // pure id extractor and will happily pull an id out of any host's
    // ?v= parameter. youtubeFetch gates on isYouTubeHost separately. A test
    // asserting null here would be asserting a contract this function does not
    // have, and "fixing" the function to match would duplicate the host check.
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });
});

describe("youtubeFetch — pages without a usable transcript", () => {
  const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  const htmlRes = (html: string, status = 200) =>
    res(html, status, "text/html");

  it("returns null when the watch page carries no captionTracks at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlRes("<html><title>V - YouTube</title></html>")),
    );
    expect(await youtubeFetch(WATCH)).toBeNull();
  });

  it("returns null when captionTracks is present but empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        htmlRes(`<html><script>{"captionTracks":[]}</script></html>`),
      ),
    );
    expect(await youtubeFetch(WATCH)).toBeNull();
  });

  it("returns null when the watch page itself fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlRes("", 404)),
    );
    expect(await youtubeFetch(WATCH)).toBeNull();
  });

  it("returns null rather than throwing when the request errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );
    expect(await youtubeFetch(WATCH)).toBeNull();
  });

  it("returns null for a YouTube URL with no extractable video id", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(
      await youtubeFetch("https://www.youtube.com/results?search_query=x"),
    ).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null when robots.txt disallows", async () => {
    checkRobotsMock.mockResolvedValue({ allowed: false } as never);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await youtubeFetch(WATCH)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
