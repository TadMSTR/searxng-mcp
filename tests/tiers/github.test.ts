import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so GITHUB_TOKEN is unset for
// this file. See github-token.test.ts for the token-set behavior.
vi.mock("../../src/config.js", () => ({
  GITHUB_TOKEN: undefined,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  githubFetch,
  isGithubFastPathUrl,
  isGithubUrl,
} from "../../src/tiers/github.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// These mocks need a real body stream: the tier reads through
// readBoundedText, which streams from res.body. A mock carrying only text()
// or json() would send it down the no-reader path and assert nothing about
// the code that actually ships.
function bodyStream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
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
    text: () => Promise.resolve(serialized),
  };
}

function textResponse(body: string, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    body: bodyStream(body),
    text: () => Promise.resolve(body),
  };
}

describe("isGithubUrl", () => {
  it("matches github.com", () => {
    expect(isGithubUrl("https://github.com/TadMSTR/searxng-mcp")).toBe(true);
  });

  it("matches raw.githubusercontent.com", () => {
    expect(
      isGithubUrl(
        "https://raw.githubusercontent.com/TadMSTR/searxng-mcp/main/README.md",
      ),
    ).toBe(true);
  });

  it("matches api.github.com", () => {
    expect(
      isGithubUrl("https://api.github.com/repos/TadMSTR/searxng-mcp"),
    ).toBe(true);
  });

  it("does not match unrelated hosts", () => {
    expect(isGithubUrl("https://example.com/github.com")).toBe(false);
    expect(isGithubUrl("https://githubusercontent.com/foo")).toBe(false);
  });

  it("returns false for an unparseable URL instead of throwing", () => {
    expect(isGithubUrl("not-a-url")).toBe(false);
  });
});

describe("isGithubFastPathUrl", () => {
  it.each([
    "https://github.com/valkey-io/valkey",
    "https://github.com/valkey-io/valkey/",
    "https://github.com/valkey-io/valkey/blob/unstable/valkey.conf",
    "https://github.com/valkey-io/valkey/tree/unstable",
    "https://github.com/valkey-io/valkey/tree/unstable/src/modules",
    "https://raw.githubusercontent.com/valkey-io/valkey/unstable/valkey.conf",
    "https://api.github.com/repos/valkey-io/valkey/releases",
    "https://github.com/valkey-io/valkey/releases",
    "https://github.com/valkey-io/valkey/releases/latest",
    "https://github.com/valkey-io/valkey/releases/tag/9.1.2",
  ])("serves %s", (url) => {
    expect(isGithubFastPathUrl(url)).toBe(true);
  });

  // The regression: every one of these used to be answered with the
  // repo-root README.
  it.each([
    "https://github.com/valkey-io/valkey/releases/download/9.1.2/x.tar.gz",
    "https://github.com/valkey-io/valkey/issues/1234",
    "https://github.com/valkey-io/valkey/pull/1234",
    "https://github.com/valkey-io/valkey/commit/abc123",
    "https://github.com/valkey-io/valkey/wiki",
    "https://github.com/valkey-io/valkey/blob",
    "https://github.com/valkey-io",
    "https://github.com/",
  ])("leaves %s to the normal cascade", (url) => {
    expect(isGithubFastPathUrl(url)).toBe(false);
  });

  it("does not match unrelated hosts or unparseable input", () => {
    expect(isGithubFastPathUrl("https://gitlab.com/a/b")).toBe(false);
    expect(isGithubFastPathUrl("not a url")).toBe(false);
  });
});

describe("githubFetch — SSRF guards", () => {
  it("rejects a non-http(s) protocol before any fetch call (SSRF-08)", async () => {
    await expect(
      githubFetch("ftp://raw.githubusercontent.com/a/b/main/f.txt"),
    ).rejects.toThrow("Only http/https URLs are supported");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not follow a redirect and does not leak the Location target (SSRF-02/OE-02)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: "Found",
      headers: new Headers({
        Location: "http://169.254.169.254/latest/meta-data",
      }),
      text: () => Promise.resolve(""),
    });
    let thrown: Error | undefined;
    try {
      await githubFetch("https://raw.githubusercontent.com/a/b/main/f.txt");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toBe(
      "GitHub raw fetch error: redirect not followed (302)",
    );
    expect(thrown?.message).not.toContain("169.254.169.254");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.redirect).toBe("manual");
  });
});

describe("githubFetch — raw.githubusercontent.com", () => {
  const RAW_URL =
    "https://raw.githubusercontent.com/TadMSTR/searxng-mcp/main/src/index.ts";

  it("fetches the raw file directly with no URL rewrite", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("export const x = 1;"));
    const result = await githubFetch(RAW_URL);
    expect(result.text).toBe("export const x = 1;");
    expect(result.title).toBe("index.ts");
    expect(result.url).toBe(RAW_URL);
    expect(mockFetch).toHaveBeenCalledWith(
      RAW_URL,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("truncates to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("x".repeat(100)));
    const result = await githubFetch(RAW_URL, 10);
    expect(result.text).toHaveLength(10);
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("not found", { status: 404 }));
    await expect(githubFetch(RAW_URL)).rejects.toThrow(
      "GitHub raw fetch error: 404",
    );
  });

  it("omits Authorization header when GITHUB_TOKEN is unset", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("content"));
    await githubFetch(RAW_URL);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("githubFetch — api.github.com", () => {
  const README_URL = "https://api.github.com/repos/TadMSTR/searxng-mcp/readme";

  it("decodes base64 README-shaped responses", async () => {
    const content = Buffer.from("# Hello").toString("base64");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        content,
        encoding: "base64",
        name: "README.md",
        html_url: "https://github.com/TadMSTR/searxng-mcp/blob/main/README.md",
      }),
    );
    const result = await githubFetch(README_URL);
    expect(result.text).toBe("# Hello");
    expect(result.title).toBe("README.md");
    expect(result.url).toBe(
      "https://github.com/TadMSTR/searxng-mcp/blob/main/README.md",
    );
  });

  it("falls back to pretty-printed JSON for non-README endpoints", async () => {
    const API_URL = "https://api.github.com/repos/TadMSTR/searxng-mcp";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ full_name: "TadMSTR/searxng-mcp", stargazers_count: 3 }),
    );
    const result = await githubFetch(API_URL);
    expect(result.text).toContain('"full_name": "TadMSTR/searxng-mcp"');
    expect(result.title).toBe("/repos/TadMSTR/searxng-mcp");
    expect(result.url).toBe(API_URL);
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: "Not Found" }, { status: 404 }),
    );
    await expect(githubFetch(README_URL)).rejects.toThrow(
      "GitHub API error: 404",
    );
  });

  it("sends Accept and X-GitHub-Api-Version headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await githubFetch("https://api.github.com/rate_limit");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("githubFetch — github.com", () => {
  it("rewrites a blob URL to raw content and fetches it", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("print('hi')"));
    const result = await githubFetch(
      "https://github.com/TadMSTR/searxng-mcp/blob/main/scripts/hi.py",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/TadMSTR/searxng-mcp/main/scripts/hi.py",
      expect.anything(),
    );
    expect(result.text).toBe("print('hi')");
    expect(result.title).toBe("hi.py");
  });

  it("fetches the repo README for a repo-root URL", async () => {
    const content = Buffer.from("# searxng-mcp").toString("base64");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        content,
        name: "README.md",
        html_url: "https://github.com/TadMSTR/searxng-mcp/blob/main/README.md",
      }),
    );
    const result = await githubFetch("https://github.com/TadMSTR/searxng-mcp");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/TadMSTR/searxng-mcp/readme",
      expect.anything(),
    );
    expect(result.text).toBe("# searxng-mcp");
    expect(result.title).toBe("TadMSTR/searxng-mcp — README.md");
  });

  it("fetches the named directory's README for a tree URL, at that ref", async () => {
    const content = Buffer.from("# modules").toString("base64");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        content,
        name: "README.md",
        html_url:
          "https://github.com/valkey-io/valkey/blob/unstable/src/modules/README.md",
      }),
    );
    const result = await githubFetch(
      "https://github.com/valkey-io/valkey/tree/unstable/src/modules",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/valkey-io/valkey/readme/src/modules?ref=unstable",
      expect.anything(),
    );
    expect(result.text).toBe("# modules");
  });

  it("fetches the root README at the given ref for a bare tree URL", async () => {
    const content = Buffer.from("# valkey").toString("base64");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ content, name: "README.md", html_url: "x" }),
    );
    await githubFetch("https://github.com/valkey-io/valkey/tree/8.1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/valkey-io/valkey/readme?ref=8.1",
      expect.anything(),
    );
  });

  it("refuses an issues URL instead of answering it with the README", async () => {
    await expect(
      githubFetch("https://github.com/valkey-io/valkey/issues/1234"),
    ).rejects.toThrow("GitHub fast path does not handle this URL");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("lists a directory's files when it has no README", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "tools.md", type: "file" },
          { name: "img", type: "dir" },
        ]),
      );
    const result = await githubFetch(
      "https://github.com/TadMSTR/searxng-mcp/tree/main/docs",
    );
    expect(mockFetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/TadMSTR/searxng-mcp/contents/docs?ref=main",
      expect.anything(),
    );
    expect(result.text).toContain("No README in docs at main");
    expect(result.text).toContain("- tools.md\n- img/");
  });

  it("rethrows a non-404 README error for a tree URL rather than listing", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    await expect(
      githubFetch("https://github.com/a/b/tree/main/docs"),
    ).rejects.toThrow("GitHub API error: 500");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("githubFetch — github.com releases", () => {
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    name: tag,
    body: `notes for ${tag}`,
    html_url: `https://github.com/valkey-io/valkey/releases/tag/${tag}`,
    published_at: "2026-09-01T12:00:00Z",
    prerelease: false,
    draft: false,
    ...extra,
  });

  it("renders the release list from the API, newest first", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        release("9.2.0-rc1", { prerelease: true, name: "Valkey 9.2 RC1" }),
        release("9.1.2"),
      ]),
    );
    const result = await githubFetch(
      "https://github.com/valkey-io/valkey/releases",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/valkey-io/valkey/releases?per_page=10",
      expect.anything(),
    );
    expect(result.url).toBe("https://github.com/valkey-io/valkey/releases");
    expect(result.text).toMatch(
      /^## 9\.2\.0-rc1 — Valkey 9\.2 RC1\n2026-09-01 \(pre-release\)/,
    );
    expect(result.text).toContain("notes for 9.2.0-rc1");
    expect(result.text).toContain("---\n\n## 9.1.2\n2026-09-01 · ");
  });

  it("fetches one tag", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(release("9.1.2")));
    const result = await githubFetch(
      "https://github.com/valkey-io/valkey/releases/tag/9.1.2",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/valkey-io/valkey/releases/tags/9.1.2",
      expect.anything(),
    );
    expect(result.title).toBe("valkey-io/valkey — 9.1.2");
    expect(result.text).toContain("notes for 9.1.2");
  });

  it("fetches the latest release", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(release("9.1.2", { body: null, published_at: null })),
    );
    const result = await githubFetch(
      "https://github.com/valkey-io/valkey/releases/latest",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/valkey-io/valkey/releases/latest",
      expect.anything(),
    );
    expect(result.text).toContain("unpublished");
  });

  it("says so when a repo has no releases", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const result = await githubFetch("https://github.com/a/b/releases");
    expect(result.text).toBe("This repository has no published releases.");
  });

  it("refuses a release asset download URL", async () => {
    await expect(
      githubFetch("https://github.com/a/b/releases/download/v1/x.tgz"),
    ).rejects.toThrow("GitHub fast path does not handle this URL");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
