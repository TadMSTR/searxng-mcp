import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so GITHUB_TOKEN is set for this
// file. See github.test.ts for the token-unset (default) behavior.
vi.mock("../../src/config.js", () => ({
  GITHUB_TOKEN: "ghp_test123",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { githubFetch } from "../../src/tiers/github.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function textResponse(body: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(body),
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  };
}

describe("githubFetch with GITHUB_TOKEN set", () => {
  it("adds a Bearer Authorization header to raw content fetches", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("content"));
    await githubFetch(
      "https://raw.githubusercontent.com/TadMSTR/searxng-mcp/main/README.md",
    );
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer ghp_test123");
  });

  it("adds a Bearer Authorization header to api.github.com fetches", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await githubFetch("https://api.github.com/rate_limit");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer ghp_test123");
  });

  it("adds a Bearer Authorization header to the readme fetch behind a blob rewrite", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("print('hi')"));
    await githubFetch(
      "https://github.com/TadMSTR/searxng-mcp/blob/main/scripts/hi.py",
    );
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer ghp_test123");
  });
});
