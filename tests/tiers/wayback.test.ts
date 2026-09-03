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

// waybackFetch reads the CDX response through readBoundedText, so these need
// a real body stream rather than `body: null`.
const cdxResponse = (body: string) => ({
  ok: true,
  body: new Response(body).body as ReadableStream<Uint8Array>,
  text: () => Promise.resolve(body),
});

const cdxHit = (snapshotUrl: string) =>
  cdxResponse(
    JSON.stringify({
      archived_snapshots: {
        closest: { url: snapshotUrl, available: true, timestamp: "20240101" },
      },
    }),
  );

const cdxMiss = () => cdxResponse(JSON.stringify({ archived_snapshots: {} }));

describe("waybackFetch", () => {
  it("fetches snapshot and returns result with [Archived] title prefix", async () => {
    mockFetch.mockResolvedValueOnce(
      cdxHit(
        "https://web.archive.org/web/20240101/https://example.com/dead-page",
      ),
    );
    const result = await waybackFetch(URL);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("[Archived] Archived Page");
    expect(result?.text).toBe(
      "> [via Wayback Machine, archived 2024-01-01]\n\nArchived content here",
    );
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
