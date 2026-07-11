import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so HISTER_URL/TOKEN are set for
// this file. See hister-unconfigured.test.ts for the gated (unset) behavior.
vi.mock("../src/config.js", () => ({
  HISTER_URL: "http://hister.internal:8123",
  HISTER_TOKEN: "hister-test-token",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { histerFetch } from "../src/hister.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const URL = "https://docs.example.com/guide";

function mcpResponse(text: string | null) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        jsonrpc: "2.0",
        id: 1,
        result: text ? { content: [{ type: "text", text }] } : { content: [] },
      }),
  };
}

function foundText(opts: { url: string; title?: string; text: string }) {
  return [
    `Found 1 result`,
    `1. ${opts.title ?? "Example Guide"}`,
    `   URL: ${opts.url}`,
    `   Text: ${opts.text}`,
  ].join("\n");
}

describe("histerFetch — query/response handling", () => {
  it("returns page content on an exact URL match", async () => {
    mockFetch.mockResolvedValueOnce(
      mcpResponse(
        foundText({
          url: URL,
          title: "Example Guide",
          text: "The guide body.",
        }),
      ),
    );
    const result = await histerFetch(URL);
    expect(result).toEqual({
      title: "Example Guide",
      url: URL,
      text: "The guide body.",
    });
  });

  it("sends a POST to {HISTER_URL}/mcp with a quoted url: filter and bearer auth", async () => {
    mockFetch.mockResolvedValueOnce(
      mcpResponse(foundText({ url: URL, text: "body" })),
    );
    await histerFetch(URL);
    const [reqUrl, init] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe("http://hister.internal:8123/mcp");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer hister-test-token");
    const body = JSON.parse(init.body);
    expect(body.params.arguments.query).toBe(`url:"${URL}"`);
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(
      mcpResponse(foundText({ url: URL, text: "x".repeat(50) })),
    );
    const result = await histerFetch(URL, 10);
    expect(result?.text).toHaveLength(10);
  });

  it("returns null when the MCP response has no results", async () => {
    mockFetch.mockResolvedValueOnce(mcpResponse(null));
    expect(await histerFetch(URL)).toBeNull();
  });

  it("returns null when the HTTP response is not ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    expect(await histerFetch(URL)).toBeNull();
  });

  it("returns null when the JSON-RPC response carries an error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }),
    });
    expect(await histerFetch(URL)).toBeNull();
  });

  it("returns null when fetch throws a non-timeout error, and logs to stderr", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await histerFetch(URL);
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("hister fetch error"),
    );
  });

  it("returns null silently (no stderr log) on an AbortError timeout", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const abortErr = new Error("The operation was aborted (AbortError)");
    mockFetch.mockRejectedValueOnce(abortErr);
    const result = await histerFetch(URL);
    expect(result).toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("histerFetch — security fixes (3.12.0)", () => {
  it("quotes the url: filter value so it round-trips exactly, including special characters", async () => {
    const specialUrl = 'https://example.com/page?q="injected" OR url:"other"';
    mockFetch.mockResolvedValueOnce(
      mcpResponse(foundText({ url: specialUrl, text: "body" })),
    );
    await histerFetch(specialUrl);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    // JSON.stringify handles escaping; the query still round-trips to the
    // exact quoted form with no ambiguity introduced by the special chars.
    expect(body.params.arguments.query).toBe(`url:"${specialUrl}"`);
  });

  it("rejects a response whose URL line does not exactly match the requested URL", async () => {
    mockFetch.mockResolvedValueOnce(
      mcpResponse(
        foundText({ url: "https://example.com/different-page", text: "body" }),
      ),
    );
    const result = await histerFetch(URL);
    expect(result).toBeNull();
  });
});
