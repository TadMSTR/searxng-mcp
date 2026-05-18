import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Reset env before each test; individual tests set what they need
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_API_KEY;
});

afterEach(() => {
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_API_KEY;
});

describe("expandQuery", () => {
  it("returns empty array when OLLAMA_URL is not set", async () => {
    const { expandQuery } = await import("../src/ollama.js");
    const result = await expandQuery("test query");
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns variant strings on success", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { expandQuery } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          response: "variant one\nvariant two\nvariant three",
        }),
    });
    const result = await expandQuery("test query");
    expect(result).toEqual(["variant one", "variant two", "variant three"]);
  });

  it("returns empty array on fetch error", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { expandQuery } = await import("../src/ollama.js");
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));
    const result = await expandQuery("test query");
    expect(result).toEqual([]);
  });

  it("includes Authorization header when OLLAMA_API_KEY is set", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    process.env.OLLAMA_API_KEY = "sk-test";
    const { expandQuery } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: "variant" }),
    });
    await expandQuery("test query");
    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((callOpts.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("strips blank lines and the original query from variants", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { expandQuery } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          response: "test query\n\nvariant one\n\nvariant two",
        }),
    });
    const result = await expandQuery("test query");
    expect(result).not.toContain("test query");
    expect(result).not.toContain("");
    expect(result).toContain("variant one");
    expect(result).toContain("variant two");
  });
});

describe("summarizePages", () => {
  it("returns empty summary when OLLAMA_URL is not set", async () => {
    const { summarizePages } = await import("../src/ollama.js");
    const result = await summarizePages("query", [
      { title: "Page", url: "https://example.com", text: "content" },
    ]);
    expect(result).toEqual({ summary: "", citations: [] });
  });

  it("returns structured summary and citations on success", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { summarizePages } = await import("../src/ollama.js");
    const payload = {
      summary: "This is the answer",
      citations: [
        {
          url: "https://example.com",
          title: "Example",
          key_facts: ["fact 1"],
        },
      ],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: JSON.stringify(payload) },
        }),
    });
    const result = await summarizePages("query", [
      { title: "Example", url: "https://example.com", text: "some text" },
    ]);
    expect(result.summary).toBe("This is the answer");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].url).toBe("https://example.com");
  });

  it("handles JSON embedded in trailing text (regex pre-parse)", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { summarizePages } = await import("../src/ollama.js");
    const payload = { summary: "answer", citations: [] };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: `Here is the result:\n${JSON.stringify(payload)}\n\nDone.`,
          },
        }),
    });
    const result = await summarizePages("query", [
      { title: "T", url: "https://example.com", text: "t" },
    ]);
    expect(result.summary).toBe("answer");
  });

  it("returns fallback when OLLAMA_URL not set and pages provided", async () => {
    const { summarizePages } = await import("../src/ollama.js");
    const result = await summarizePages("q", [
      { title: "T", url: "https://example.com", text: "t" },
    ]);
    expect(result).toEqual({ summary: "", citations: [] });
  });
});
