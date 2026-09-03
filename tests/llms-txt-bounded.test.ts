import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/domains.js", () => ({
  getLlmsTxtAllowlist: vi.fn(() => ["docs.anthropic.com"]),
}));

vi.mock("../src/domain-db.js", () => ({
  recordLlmsFullProbe: vi.fn(async () => {}),
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import { _clearBodyCacheForTests, tryLlmsTxtFetch } from "../src/llms-txt.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);

const ORIGIN = "https://docs.anthropic.com";
const PAGE = `${ORIGIN}/en/get-started`;

// A document the fast path should accept, shaped so extractSection finds the
// section for PAGE.
function docOfSize(bytes: number): string {
  const head = `# Docs

## Section: First steps

---

# Get started

URL: ${PAGE}

Real content lives here.
`;
  const pad = "x".repeat(Math.max(0, bytes - Buffer.byteLength(head, "utf-8")));
  return head + pad;
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearBodyCacheForTests();
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearBodyCacheForTests();
});

describe("llms-full.txt — an oversized document is absent, never truncated content", () => {
  it("reports absent for a body past MAX_SIZE_BYTES rather than serving the truncated prefix", async () => {
    // 64 MB is the ceiling; offer more. The read is bounded at the ceiling
    // plus one byte, which is the whole point — capping at exactly the
    // ceiling would truncate to exactly the ceiling, the size check would
    // then pass, and a partial document would be served as the real thing.
    const oversized = docOfSize(64 * 1024 * 1024 + 4096);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(oversized, { status: 200 }) as Response,
    );

    const out = await tryLlmsTxtFetch(PAGE, 8000);

    // Absent -> null -> falls through to the tier cascade.
    expect(out).toBeNull();

    // And it was recorded absent, not present-with-a-body. The body key must
    // never be written for a document that hit the cap.
    const setKeys = cacheSetMock.mock.calls.map((c) => String(c[0]));
    expect(setKeys.some((k) => k.endsWith(":body"))).toBe(false);
    const probeWrite = cacheSetMock.mock.calls.find((c) =>
      String(c[0]).includes(":probe"),
    );
    if (probeWrite) {
      expect(String(probeWrite[1])).toContain('"absent"');
    }
  }, 60_000);

  it("accepts a document comfortably under the ceiling", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(docOfSize(64 * 1024), { status: 200 }) as Response,
    );

    const out = await tryLlmsTxtFetch(PAGE, 8000);
    expect(out).not.toBeNull();
    expect(out?.source).toBe("llms_full_txt");
    expect(out?.text).toContain("Real content lives here.");
  });
});

describe("llms-full.txt — L1 admits the documents the fetch path accepts", () => {
  it("caches a body larger than the old 10 MB L1 cap instead of refusing it every session", async () => {
    // 12 MB: accepted by the fetch path both before and after this change, but
    // previously refused by the L1 cache, whose cap was 10 MB. The real case
    // is docs.anthropic.com at 40.3 MB — every session paid the full round
    // trip and the cache it was meant to warm never held it. 12 MB reproduces
    // the same branch far more cheaply.
    // A fresh Response per call, deliberately. Re-using one would let this
    // test "pass" for the wrong reason: the second read would find an already
    // drained body and return absent, which looks like a cache hit in the
    // result but proves nothing about whether the network was touched.
    const doc = docOfSize(12 * 1024 * 1024);
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementation(
        async () => new Response(doc, { status: 200 }) as Response,
      );

    const first = await tryLlmsTxtFetch(PAGE, 8000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();

    // Valkey is mocked empty, so L1 is the only thing that can prevent a
    // second network read. The call count is the assertion that matters.
    const second = await tryLlmsTxtFetch(PAGE, 8000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).not.toBeNull();
    expect(second?.text).toContain("Real content lives here.");
  }, 30_000);
});
