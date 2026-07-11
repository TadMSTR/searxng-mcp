import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so GITHUB_TOKEN is unset for
// this file. See github-token.test.ts for the token-set behavior.
vi.mock("../../src/config.js", () => ({
  GITHUB_TOKEN: undefined,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { githubFetch, isGithubUrl } from "../../src/tiers/github.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function textResponse(body: string, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
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
});
