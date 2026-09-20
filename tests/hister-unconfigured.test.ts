import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so HISTER_URL/TOKEN are unset,
// matching the default (env vars not exported by run-searxng-mcp.sh).
vi.mock("../src/config.js", () => ({
  HISTER_URL: "",
  HISTER_TOKEN: "",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { histerConfigured, histerFetch } from "../src/hister.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("histerFetch — gated when unconfigured", () => {
  it("returns null and never calls fetch when HISTER_URL/HISTER_TOKEN are unset", async () => {
    expect(await histerFetch("https://example.com/page")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("histerConfigured() is false, which is what gates the span at the call site", () => {
    // Exported so fetch.ts can test this BEFORE opening a span. With the check
    // only inside histerFetch, the span wrapped the call unconditionally and the
    // running container — which has no HISTER_* at all — produced ~60 `hister`
    // spans over 15 days, none of them a real lookup (vikunja#643).
    expect(histerConfigured()).toBe(false);
  });
});
