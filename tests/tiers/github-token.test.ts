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

// Real body streams — the tier reads via readBoundedText, which needs
// res.body. See tests/tiers/github.test.ts for the same note.
function bodyStream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

function textResponse(body: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: bodyStream(body),
    text: () => Promise.resolve(body),
  };
}

function jsonResponse(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    body: bodyStream(serialized),
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

  it("adds a Bearer Authorization header to a repository api.github.com fetch", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await githubFetch(
      "https://api.github.com/repos/TadMSTR/searxng-mcp/contents/src",
    );
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

// The token goes only with the repository endpoints the fast path builds.
// Every other api.github.com URL a caller names is fetched without it.
describe("which requests carry GITHUB_TOKEN", () => {
  /** The Authorization header sent with each fetch call so far. */
  const sentAuth = () =>
    mockFetch.mock.calls.map(([url, init]) => [
      url,
      init.headers.Authorization,
    ]);

  it.each([
    "https://api.github.com/repos/o/r/readme",
    "https://api.github.com/repos/o/r/readme/docs/api?ref=main",
    "https://api.github.com/repos/o/r/contents/?ref=main",
    "https://api.github.com/repos/o/r/contents/docs/a.md",
    "https://api.github.com/repos/o/r/releases?per_page=10",
    "https://api.github.com/repos/o/r/releases/latest",
    "https://api.github.com/repos/o/r/releases/tags/v1.0.0",
    "https://api.github.com/repos/o/r/releases/tags/release/3.31.0",
    "https://api.github.com/repos/o/r/git/matching-refs/heads/feat",
    "https://api.github.com/repos/o/r/git/matching-refs/tags/v1",
    "https://raw.githubusercontent.com/o/r/main/README.md",
  ])("sends it to %s", async (url) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await githubFetch(url);
    expect(sentAuth()).toEqual([[url, "Bearer ghp_test123"]]);
  });

  it.each([
    "https://api.github.com/user",
    "https://api.github.com/user/repos",
    "https://api.github.com/notifications",
    "https://api.github.com/orgs/x/members",
    "https://api.github.com/repos/o/r/collaborators",
    "https://api.github.com/repos/o/r",
    "https://api.github.com/rate_limit",
    "https://api.github.com/repos/o/r/releases/assets/1",
    "https://api.github.com/repos/o/r/git/matching-refs/heads/a/b",
    "https://api.github.com/repos/o/r/readme/..%2F..%2F..%2Fuser",
    "https://api.github.com/repos/o/r/contents//x",
    "https://api.github.com/repos/o%2Fx/r/readme",
    "https://raw.githubusercontent.com/o/r/README.md",
  ])("fetches %s without it", async (url) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await githubFetch(url);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentAuth()).toEqual([[url, undefined]]);
  });

  it("sends it with every request a github.com tree URL makes", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse([{ name: "a.md", type: "file" }]));
    await githubFetch("https://github.com/o/r/tree/main/docs");
    expect(sentAuth()).toEqual([
      [
        "https://api.github.com/repos/o/r/git/matching-refs/heads/main",
        "Bearer ghp_test123",
      ],
      [
        "https://api.github.com/repos/o/r/git/matching-refs/tags/main",
        "Bearer ghp_test123",
      ],
      [
        "https://api.github.com/repos/o/r/readme/docs?ref=main",
        "Bearer ghp_test123",
      ],
      [
        "https://api.github.com/repos/o/r/contents/docs?ref=main",
        "Bearer ghp_test123",
      ],
    ]);
  });
});
