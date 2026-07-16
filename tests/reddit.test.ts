import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  REDDIT_FASTPATH_ENABLED: true,
  REDDIT_IGNORE_ROBOTS: false,
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { isRedditHost, redditFetch } from "../src/reddit.js";
import { checkRobots } from "../src/robots.js";

const THREAD_URL = "https://www.reddit.com/r/homelab/comments/abc123/my_post/";

function threadJson() {
  return [
    {
      data: {
        children: [
          {
            data: {
              title: "My great post",
              author: "ted",
              subreddit: "homelab",
              selftext: "Body of the post.",
              score: 42,
            },
          },
        ],
      },
    },
    {
      data: {
        children: [
          { data: { author: "alice", body: "Nice setup", score: 10 } },
          { data: { author: "AutoModerator", body: "rules", score: 1 } },
          { data: { author: "bob", body: "Agreed", score: 5 } },
        ],
      },
    },
  ];
}

describe("isRedditHost", () => {
  it.each([
    "https://www.reddit.com/r/x/comments/1/a/",
    "https://old.reddit.com/r/x/comments/1/a/",
    "https://reddit.com/r/x",
  ])("returns true for %s", (url) => {
    expect(isRedditHost(url)).toBe(true);
  });

  it("returns false for non-Reddit hosts and bad URLs", () => {
    expect(isRedditHost("https://example.com/r/x")).toBe(false);
    expect(isRedditHost("not-a-url")).toBe(false);
  });
});

describe("redditFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(checkRobots).mockResolvedValue({ allowed: true });
  });

  it("appends .json and parses post + top comments (excluding AutoModerator)", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(threadJson()), { status: 200 }),
      );
    const result = await redditFetch(THREAD_URL);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.reddit.com/r/homelab/comments/abc123/my_post.json",
      expect.any(Object),
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("My great post");
    expect(result?.text).toContain("My great post");
    expect(result?.text).toContain("Body of the post.");
    expect(result?.text).toContain("u/alice");
    expect(result?.text).toContain("u/bob");
    expect(result?.text).not.toContain("AutoModerator");
  });

  it("returns null on HTTP 429 (rate limited) so the cascade can try", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );
    const result = await redditFetch(THREAD_URL);
    expect(result).toBeNull();
  });

  it("returns null for a non-thread response shape", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "Listing", data: {} }), {
        status: 200,
      }),
    );
    const result = await redditFetch(THREAD_URL);
    expect(result).toBeNull();
  });

  it("returns null when robots disallows and the operator hasn't opted in", async () => {
    vi.mocked(checkRobots).mockResolvedValueOnce({
      allowed: false,
      reason: "disallowed",
    });
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await redditFetch(THREAD_URL);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
