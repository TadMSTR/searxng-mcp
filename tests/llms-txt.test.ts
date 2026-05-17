import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../src/domains.js", () => ({
  getLlmsTxtAllowlist: vi.fn(() => ["docs.anthropic.com", "docs.stripe.com"]),
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import {
  _clearBodyCacheForTests,
  extractSection,
  isLlmsTxtDomain,
  tryLlmsTxtFetch,
} from "../src/llms-txt.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);

const PADDING = "Additional context paragraph for this section. ".repeat(20);
const SAMPLE_LLMS_FULL = `# Anthropic Developer Documentation - Full Content

## Section: First steps

---

# Get started with Claude

URL: https://platform.claude.com/docs/en/get-started

Make your first API call to Claude and build a simple web search assistant.
${PADDING}

## Prerequisites

- A Console account

---

# Messages API

URL: https://platform.claude.com/docs/en/api/messages

Send a structured prompt to Claude and get a structured response back.
${PADDING}

---

# Pricing

URL: https://platform.claude.com/docs/en/pricing

Per-model pricing tiers.
${PADDING}
`;

describe("isLlmsTxtDomain", () => {
  it("matches a domain exactly in the allowlist", () => {
    expect(isLlmsTxtDomain("https://docs.anthropic.com/en/get-started")).toBe(
      true,
    );
  });

  it("matches a subdomain of a listed domain", () => {
    expect(
      isLlmsTxtDomain("https://api.docs.anthropic.com/en/get-started", [
        "docs.anthropic.com",
      ]),
    ).toBe(true);
  });

  it("strips www. for matching", () => {
    expect(
      isLlmsTxtDomain("https://www.docs.anthropic.com/en/get-started"),
    ).toBe(true);
  });

  it("rejects domains not in the allowlist", () => {
    expect(isLlmsTxtDomain("https://example.com/foo")).toBe(false);
  });

  it("returns false on malformed URLs", () => {
    expect(isLlmsTxtDomain("not-a-url")).toBe(false);
  });

  it("returns false on empty allowlist", () => {
    expect(isLlmsTxtDomain("https://docs.anthropic.com/x", [])).toBe(false);
  });
});

describe("extractSection", () => {
  it("returns the matching section by URL line (suffix match across hosts)", () => {
    const out = extractSection(
      SAMPLE_LLMS_FULL,
      "https://docs.anthropic.com/en/get-started",
    );
    expect(out?.text).toContain("Get started with Claude");
    expect(out?.text).toContain("Make your first API call");
    expect(out?.text).not.toContain("Messages API");
  });

  it("returns null when no section matches", () => {
    expect(
      extractSection(SAMPLE_LLMS_FULL, "https://docs.anthropic.com/nope"),
    ).toBeNull();
  });

  it("matches markdown link headings as a fallback", () => {
    const content = `# Docs

## [Quickstart](/quickstart)

Quickstart content here.

## [Advanced](/advanced)

Advanced content here.
`;
    const out = extractSection(content, "https://docs.example.com/quickstart");
    expect(out?.title).toBe("Quickstart");
    expect(out?.text).toContain("Quickstart content here.");
    expect(out?.text).not.toContain("Advanced content");
  });

  it("uses the heading level to bound the section", () => {
    const content = `## [Page A](/page-a)
Content A.
### Subsection of A
More content A.
## [Page B](/page-b)
Content B.
`;
    const out = extractSection(content, "https://docs.example.com/page-a");
    expect(out?.text).toContain("Content A.");
    expect(out?.text).toContain("Subsection of A");
    expect(out?.text).not.toContain("Content B.");
  });
});

describe("tryLlmsTxtFetch", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
    _clearBodyCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the URL is not on the allowlist", async () => {
    const out = await tryLlmsTxtFetch("https://example.com/page", 8000);
    expect(out).toBeNull();
  });

  it("returns a fetch result when llms-full.txt has a matching section", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_LLMS_FULL, { status: 200 }) as Response,
    );
    const out = await tryLlmsTxtFetch(
      "https://docs.anthropic.com/en/get-started",
      4000,
    );
    expect(out).not.toBeNull();
    expect(out?.source).toBe("llms_full_txt");
    expect(out?.text).toContain("Make your first API call");
    expect(out?.text.length).toBeLessThanOrEqual(4000);
  });

  it("returns null when the cache says the file is absent", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ status: "absent", fetched: "2026-05-17T00:00:00Z" }),
    );
    const out = await tryLlmsTxtFetch(
      "https://docs.anthropic.com/en/get-started",
      8000,
    );
    expect(out).toBeNull();
  });

  it("returns null when no section in the file matches", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_LLMS_FULL, { status: 200 }) as Response,
    );
    const out = await tryLlmsTxtFetch(
      "https://docs.anthropic.com/totally-missing-page",
      8000,
    );
    expect(out).toBeNull();
  });

  it("records the present flag with 24h TTL when llms-full.txt is fetched", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(SAMPLE_LLMS_FULL, { status: 200 }) as Response,
    );
    const out = await tryLlmsTxtFetch(
      "https://docs.anthropic.com/en/get-started",
      8000,
    );
    expect(out).not.toBeNull();
    expect(cacheSetMock).toHaveBeenCalled();
    const [, value, ttl] = cacheSetMock.mock.calls[0];
    const cached = JSON.parse(value as string);
    expect(cached.status).toBe("present");
    expect(cached).not.toHaveProperty("body");
    expect(ttl).toBe(24 * 60 * 60);
  });

  it("caches absent for 7 days when fetch returns non-OK", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 404 }) as Response,
    );
    const out = await tryLlmsTxtFetch("https://docs.anthropic.com/x", 8000);
    expect(out).toBeNull();
    const [, , ttl] = cacheSetMock.mock.calls[0];
    expect(ttl).toBe(7 * 24 * 60 * 60);
  });

  it("rejects llms-full.txt smaller than 1KB", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("# tiny\nNot enough content", { status: 200 }) as Response,
    );
    const out = await tryLlmsTxtFetch("https://docs.anthropic.com/x", 8000);
    expect(out).toBeNull();
  });
});
