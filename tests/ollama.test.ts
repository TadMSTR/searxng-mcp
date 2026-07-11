import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation } from "../src/types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Reset env before each test; individual tests set what they need
const LLM_ENV = [
  "OLLAMA_URL",
  "OLLAMA_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_API_KEY",
  "LLM_DISABLE_THINKING",
];
function clearLlmEnv() {
  for (const k of LLM_ENV) delete process.env[k];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  clearLlmEnv();
});

afterEach(clearLlmEnv);

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

  it("normalizes a citation missing key_facts to an empty array", async () => {
    // Regression: a model may omit key_facts. Previously this survived
    // summarizePages and later crashed formatSummaryResult on
    // `c.key_facts.map(...)`.
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { summarizePages } = await import("../src/ollama.js");
    const payload = {
      summary: "answer",
      citations: [{ url: "https://example.com", title: "Example" }],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ message: { content: JSON.stringify(payload) } }),
    });
    const result = await summarizePages("query", [
      { title: "Example", url: "https://example.com", text: "t" },
    ]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].key_facts).toEqual([]);
  });

  it("drops non-string key_facts entries", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const { summarizePages } = await import("../src/ollama.js");
    const payload = {
      summary: "answer",
      citations: [
        { url: "https://x.com", title: "X", key_facts: ["ok", 42, null] },
      ],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ message: { content: JSON.stringify(payload) } }),
    });
    const result = await summarizePages("query", [
      { title: "X", url: "https://x.com", text: "t" },
    ]);
    expect(result.citations[0].key_facts).toEqual(["ok"]);
  });
});

describe("formatSummaryResult", () => {
  it("returns empty string when summary is empty", async () => {
    const { formatSummaryResult } = await import("../src/ollama.js");
    expect(formatSummaryResult({ summary: "", citations: [] })).toBe("");
  });

  it("does not throw when a citation is missing key_facts", async () => {
    // Defensive: the exported formatter must tolerate malformed citations
    // even if a caller bypasses summarizePages' normalization.
    const { formatSummaryResult } = await import("../src/ollama.js");
    const out = formatSummaryResult({
      summary: "answer",
      citations: [
        { url: "https://example.com", title: "Example" } as unknown as Citation,
      ],
    });
    expect(out).toContain("answer");
    expect(out).toContain("https://example.com");
  });

  it("renders key_facts as bulleted lines when present", async () => {
    const { formatSummaryResult } = await import("../src/ollama.js");
    const out = formatSummaryResult({
      summary: "answer",
      citations: [
        { url: "https://x.com", title: "X", key_facts: ["f1", "f2"] },
      ],
    });
    expect(out).toContain("- f1");
    expect(out).toContain("- f2");
  });
});

describe("OpenAI-compatible backend (LLM_BASE_URL)", () => {
  const okJson = (content: string) => ({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  });
  const lastCall = () => mockFetch.mock.calls[0] as [string, RequestInit];
  const bodyOf = (opts: RequestInit) => JSON.parse(opts.body as string);

  it("summarizePages POSTs to <LLM_BASE_URL>/chat/completions with thinking disabled and LLM_MODEL", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.LLM_MODEL = "my-model";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce(
      okJson(JSON.stringify({ summary: "s", citations: [] })),
    );
    const result = await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    const [url, opts] = lastCall();
    expect(url).toBe("http://llm:8000/v1/chat/completions");
    const body = bodyOf(opts);
    expect(body.model).toBe("my-model");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(
      (opts.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(result.summary).toBe("s");
  });

  it("strips a single trailing slash from LLM_BASE_URL", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1/";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce(okJson('{"summary":"s","citations":[]}'));
    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    expect(lastCall()[0]).toBe("http://llm:8000/v1/chat/completions");
  });

  it("omits chat_template_kwargs when LLM_DISABLE_THINKING=false", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.LLM_DISABLE_THINKING = "false";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce(okJson('{"summary":"s","citations":[]}'));
    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    expect(bodyOf(lastCall()[1]).chat_template_kwargs).toBeUndefined();
  });

  it("adds Authorization when LLM_API_KEY is set", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.LLM_API_KEY = "sk-abc";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce(okJson('{"summary":"s","citations":[]}'));
    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    expect(
      (lastCall()[1].headers as Record<string, string>).Authorization,
    ).toBe("Bearer sk-abc");
  });

  it("degrades to empty summary when choices are missing", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const result = await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    expect(result).toEqual({ summary: "", citations: [] });
  });

  it("expandQuery uses /chat/completions when LLM_BASE_URL is set", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    const { expandQuery } = await import("../src/ollama.js");
    mockFetch.mockResolvedValueOnce(okJson("variant one\nvariant two"));
    const result = await expandQuery("orig");
    expect(lastCall()[0]).toBe("http://llm:8000/v1/chat/completions");
    expect(result).toEqual(["variant one", "variant two"]);
  });
});

describe("F-01: cleartext LLM credential warning", () => {
  const okJson = (content: string) => ({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  });

  it("warns once when LLM_API_KEY is set with a plain-http LLM_BASE_URL", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.LLM_API_KEY = "sk-abc";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValue(okJson('{"summary":"s","citations":[]}'));

    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);
    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);

    const cleartextWarnings = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes("cleartext"),
    );
    expect(cleartextWarnings).toHaveLength(1);
    expect(cleartextWarnings[0][0]).toContain("http://llm:8000/v1");
  });

  it("does not warn when LLM_BASE_URL is https", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LLM_BASE_URL = "https://llm:8000/v1";
    process.env.LLM_API_KEY = "sk-abc";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValue(okJson('{"summary":"s","citations":[]}'));

    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);

    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("cleartext")),
    ).toBe(false);
  });

  it("does not warn when LLM_API_KEY is unset", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    const { summarizePages } = await import("../src/ollama.js");
    mockFetch.mockResolvedValue(okJson('{"summary":"s","citations":[]}'));

    await summarizePages("q", [
      { title: "T", url: "https://e.com", text: "t" },
    ]);

    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("cleartext")),
    ).toBe(false);
  });
});
