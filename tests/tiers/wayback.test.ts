import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// rawFetch needs fetch stubbed; mock assertPublicUrl so archive.org passes
vi.mock("../../src/tiers/raw.js", () => ({
  rawFetch: vi.fn().mockResolvedValue({
    title: "Archived Page",
    url: "https://web.archive.org/web/20240101/https://example.com/page",
    text: "Archived content here",
    html: "<p>html</p>",
  }),
}));

import { rawFetch } from "../../src/tiers/raw.js";
import { waybackFetch } from "../../src/tiers/wayback.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/dead-page";

const cdxHit = (snapshotUrl: string) => {
  const body = JSON.stringify({
    archived_snapshots: {
      closest: { url: snapshotUrl, available: true, timestamp: "20240101" },
    },
  });
  return { ok: true, body: null, text: () => Promise.resolve(body) };
};

const cdxMiss = () => {
  const body = JSON.stringify({ archived_snapshots: {} });
  return { ok: true, body: null, text: () => Promise.resolve(body) };
};

describe("waybackFetch", () => {
  it("fetches snapshot and returns result with [Archived] title prefix", async () => {
    mockFetch.mockResolvedValueOnce(
      cdxHit(
        "https://web.archive.org/web/20240101/https://example.com/dead-page",
      ),
    );
    const result = await waybackFetch(URL);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("[Archived] Archived Page");
    expect(result!.text).toBe("Archived content here");
    expect(rawFetch).toHaveBeenCalledOnce();
  });

  it("returns null when CDX API returns no closest snapshot", async () => {
    mockFetch.mockResolvedValueOnce(cdxMiss());
    const result = await waybackFetch(URL);
    expect(result).toBeNull();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it("returns null when CDX API responds with non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    });
    const result = await waybackFetch(URL);
    expect(result).toBeNull();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it("returns null when CDX API fetch times out or throws", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const result = await waybackFetch(URL);
    expect(result).toBeNull();
  });

  it("returns null when rawFetch throws (snapshot unavailable)", async () => {
    mockFetch.mockResolvedValueOnce(
      cdxHit(
        "https://web.archive.org/web/20240101/https://example.com/dead-page",
      ),
    );
    vi.mocked(rawFetch).mockRejectedValueOnce(
      new Error("Raw fetch error: 404"),
    );
    const result = await waybackFetch(URL);
    expect(result).toBeNull();
  });
});
