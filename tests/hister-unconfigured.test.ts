import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so HISTER_URL/TOKEN are unset,
// matching the default (env vars not exported by run-searxng-mcp.sh).
vi.mock("../src/config.js", () => ({
  HISTER_URL: "",
  HISTER_TOKEN: "",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { histerFetch } from "../src/hister.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("histerFetch — gated when unconfigured", () => {
  it("returns null and never calls fetch when HISTER_URL/HISTER_TOKEN are unset", async () => {
    const result = await histerFetch("https://example.com/page");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
