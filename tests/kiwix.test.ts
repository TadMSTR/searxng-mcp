import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  KIWIX_URL: "http://localhost:8292",
}));

vi.mock("../src/extractors/readability.js", () => ({
  runReadability: vi.fn(),
}));

import { runReadability } from "../src/extractors/readability.js";
import { isKiwixHost, kiwixFetch } from "../src/kiwix.js";

const runReadabilityMock = vi.mocked(runReadability);

const SAMPLE_HTML = "<html><body><article>Btrfs content</article></body></html>";
const SAMPLE_READABLE = { title: "Btrfs - Wikipedia", text: "Btrfs content here." };

describe("isKiwixHost", () => {
  it("returns true for en.wikipedia.org", () => {
    expect(isKiwixHost("https://en.wikipedia.org/wiki/Btrfs")).toBe(true);
  });

  it("returns true for wikipedia.org", () => {
    expect(isKiwixHost("https://wikipedia.org/wiki/Linux")).toBe(true);
  });

  it("returns true for stackoverflow.com", () => {
    expect(isKiwixHost("https://stackoverflow.com/questions/12345/slug")).toBe(true);
  });

  it("returns true for wiki.archlinux.org", () => {
    expect(isKiwixHost("https://wiki.archlinux.org/title/Btrfs")).toBe(true);
  });

  it("returns false for non-Kiwix hosts", () => {
    expect(isKiwixHost("https://example.com/page")).toBe(false);
    expect(isKiwixHost("https://github.com/repo")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isKiwixHost("not-a-url")).toBe(false);
  });
});

describe("kiwixFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runReadabilityMock.mockReset();
  });

  it("fetches article and returns extracted text", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_HTML, { status: 200 }),
    );
    runReadabilityMock.mockReturnValue(SAMPLE_READABLE);

    const result = await kiwixFetch("https://en.wikipedia.org/wiki/Btrfs");

    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://en.wikipedia.org/wiki/Btrfs");
    expect(result!.title).toBe("Btrfs - Wikipedia");
    expect(result!.text).toBe("Btrfs content here.");
    expect(result!.html).toBe(SAMPLE_HTML);
  });

  it("constructs correct content URL for Wikipedia (/wiki/ path)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_HTML, { status: 200 }),
    );
    runReadabilityMock.mockReturnValue(SAMPLE_READABLE);

    await kiwixFetch("https://en.wikipedia.org/wiki/Btrfs");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8292/content/wikipedia_en_all_mini/A/Btrfs",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("constructs correct content URL for Arch Wiki (/title/ path)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_HTML, { status: 200 }),
    );
    runReadabilityMock.mockReturnValue(SAMPLE_READABLE);

    await kiwixFetch("https://wiki.archlinux.org/title/Btrfs");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8292/content/archlinux.wiki_en_all/A/Btrfs",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null when Kiwix returns a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const result = await kiwixFetch("https://en.wikipedia.org/wiki/NonExistent");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (Kiwix down)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await kiwixFetch("https://en.wikipedia.org/wiki/Btrfs");
    expect(result).toBeNull();
  });

  it("returns null when readability extracts no text", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_HTML, { status: 200 }),
    );
    runReadabilityMock.mockReturnValue(null);

    const result = await kiwixFetch("https://en.wikipedia.org/wiki/Btrfs");
    expect(result).toBeNull();
  });

  it("truncates text to maxChars", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_HTML, { status: 200 }),
    );
    runReadabilityMock.mockReturnValue({ title: "Long", text: "x".repeat(5000) });

    const result = await kiwixFetch("https://en.wikipedia.org/wiki/Long", 100);
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(100);
  });
});
