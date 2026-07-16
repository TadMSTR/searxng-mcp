import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  YOUTUBE_TRANSCRIPT_ENABLED: true,
  YOUTUBE_IGNORE_ROBOTS: false,
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { checkRobots } from "../src/robots.js";
import { extractVideoId, isYouTubeHost, youtubeFetch } from "../src/youtube.js";

const WATCH_HTML = `<!doctype html><html><head><title>Rick Astley - Never Gonna Give You Up - YouTube</title></head><body><script>var x = {"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en","kind":"asr"}],"audioTracks":[]};</script></body></html>`;
const TIMEDTEXT_XML = `<?xml version="1.0"?><transcript><text start="0" dur="2">Never gonna &amp;#39;give&amp;#39; you up</text><text start="2" dur="2">Never gonna let you down</text></transcript>`;

describe("isYouTubeHost", () => {
  it.each([
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://youtube.com/watch?v=abcdefghijk",
    "https://m.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk",
  ])("returns true for %s", (url) => {
    expect(isYouTubeHost(url)).toBe(true);
  });

  it("returns false for non-YouTube hosts and bad URLs", () => {
    expect(isYouTubeHost("https://example.com/watch?v=x")).toBe(false);
    expect(isYouTubeHost("not-a-url")).toBe(false);
  });
});

describe("extractVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0", "dQw4w9WgXcQ"],
  ])("extracts id from %s", (url, id) => {
    expect(extractVideoId(url)).toBe(id);
  });

  it("returns null when no valid 11-char id is present", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(
      extractVideoId("https://www.youtube.com/feed/subscriptions"),
    ).toBeNull();
  });
});

describe("youtubeFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(checkRobots).mockResolvedValue({ allowed: true });
  });

  it("fetches the watch page then the transcript and decodes entities", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(WATCH_HTML, { status: 200 }))
      .mockResolvedValueOnce(new Response(TIMEDTEXT_XML, { status: 200 }));

    const result = await youtubeFetch(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Rick Astley - Never Gonna Give You Up");
    expect(result?.text).toContain("Never gonna 'give' you up");
    expect(result?.text).toContain("Never gonna let you down");
  });

  it("returns null (fall through) when the page has no caption tracks", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("<html><title>No caps</title></html>", { status: 200 }),
    );
    const result = await youtubeFetch(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).toBeNull();
  });

  it("returns null when robots disallows and the operator hasn't opted in", async () => {
    vi.mocked(checkRobots).mockResolvedValueOnce({
      allowed: false,
      reason: "disallowed",
    });
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await youtubeFetch(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null for a URL with no extractable video id", async () => {
    const result = await youtubeFetch("https://www.youtube.com/feed/trending");
    expect(result).toBeNull();
  });

  it("returns null when the transcript endpoint fails", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(WATCH_HTML, { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const result = await youtubeFetch(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).toBeNull();
  });
});
