import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_ENV = [
  "CACHE_URL",
  "VALKEY_URL",
  "REDIS_URL",
  "LLM_BASE_URL",
  "LLM_DISABLE_THINKING",
  "RERANK_RECENCY_WEIGHT",
  "KIWIX_URL",
  "HISTER_URL",
  "CACHE_COMMAND_TIMEOUT_MS",
  "CACHE_CONNECT_TIMEOUT_MS",
  "CACHE_MAX_RETRIES_PER_REQUEST",
  "HTTP_SESSION_IDLE_TIMEOUT_MS",
  "HTTP_MAX_SESSIONS",
];

function clearConfigEnv() {
  for (const k of CONFIG_ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearConfigEnv();
});

afterEach(clearConfigEnv);

describe("CACHE_URL alias fallback chain", () => {
  it("defaults to localhost:6381 when nothing is set", async () => {
    const { CACHE_URL } = await import("../src/config.js");
    expect(CACHE_URL).toBe("redis://localhost:6381");
  });

  it("prefers CACHE_URL over VALKEY_URL and REDIS_URL", async () => {
    process.env.CACHE_URL = "redis://cache-wins:1";
    process.env.VALKEY_URL = "redis://valkey:2";
    process.env.REDIS_URL = "redis://redis:3";
    const { CACHE_URL } = await import("../src/config.js");
    expect(CACHE_URL).toBe("redis://cache-wins:1");
  });

  it("falls back to VALKEY_URL when CACHE_URL is unset", async () => {
    process.env.VALKEY_URL = "redis://valkey-wins:2";
    process.env.REDIS_URL = "redis://redis:3";
    const { CACHE_URL } = await import("../src/config.js");
    expect(CACHE_URL).toBe("redis://valkey-wins:2");
  });

  it("falls back to REDIS_URL when CACHE_URL and VALKEY_URL are unset", async () => {
    process.env.REDIS_URL = "redis://redis-wins:3";
    const { CACHE_URL } = await import("../src/config.js");
    expect(CACHE_URL).toBe("redis://redis-wins:3");
  });
});

describe("LLM_BASE_URL trailing-slash stripping (PR #16)", () => {
  it("strips a single trailing slash", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1/";
    const { LLM_BASE_URL } = await import("../src/config.js");
    expect(LLM_BASE_URL).toBe("http://llm:8000/v1");
  });

  it("leaves a URL with no trailing slash unchanged", async () => {
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    const { LLM_BASE_URL } = await import("../src/config.js");
    expect(LLM_BASE_URL).toBe("http://llm:8000/v1");
  });

  it("defaults to empty string when unset", async () => {
    const { LLM_BASE_URL } = await import("../src/config.js");
    expect(LLM_BASE_URL).toBe("");
  });
});

describe("LLM_DISABLE_THINKING", () => {
  it("defaults to true when unset", async () => {
    const { LLM_DISABLE_THINKING } = await import("../src/config.js");
    expect(LLM_DISABLE_THINKING).toBe(true);
  });

  it("is false only when explicitly set to the string 'false'", async () => {
    process.env.LLM_DISABLE_THINKING = "false";
    const { LLM_DISABLE_THINKING } = await import("../src/config.js");
    expect(LLM_DISABLE_THINKING).toBe(false);
  });

  it("stays true for any other value", async () => {
    process.env.LLM_DISABLE_THINKING = "no";
    const { LLM_DISABLE_THINKING } = await import("../src/config.js");
    expect(LLM_DISABLE_THINKING).toBe(true);
  });
});

describe("RERANK_RECENCY_WEIGHT parsing/fallback", () => {
  it("defaults to 0.15 when unset", async () => {
    const { RERANK_RECENCY_WEIGHT } = await import("../src/config.js");
    expect(RERANK_RECENCY_WEIGHT).toBe(0.15);
  });

  it("parses a valid custom value", async () => {
    process.env.RERANK_RECENCY_WEIGHT = "0.4";
    const { RERANK_RECENCY_WEIGHT } = await import("../src/config.js");
    expect(RERANK_RECENCY_WEIGHT).toBe(0.4);
  });

  it("disables recency weighting (returns 0) and warns on a NaN value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RERANK_RECENCY_WEIGHT = "not-a-number";
    const { RERANK_RECENCY_WEIGHT } = await import("../src/config.js");
    expect(RERANK_RECENCY_WEIGHT).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid"));
  });

  it("disables recency weighting (returns 0) on a negative value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RERANK_RECENCY_WEIGHT = "-0.5";
    const { RERANK_RECENCY_WEIGHT } = await import("../src/config.js");
    expect(RERANK_RECENCY_WEIGHT).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("keeps a value greater than 1 but warns it may dominate relevance", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RERANK_RECENCY_WEIGHT = "1.5";
    const { RERANK_RECENCY_WEIGHT } = await import("../src/config.js");
    expect(RERANK_RECENCY_WEIGHT).toBe(1.5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exceeds 1.0"),
    );
  });
});

describe("cache resilience timeouts (positiveIntEnv)", () => {
  it("defaults to 2500/3000/2 when unset", async () => {
    const {
      CACHE_COMMAND_TIMEOUT_MS,
      CACHE_CONNECT_TIMEOUT_MS,
      CACHE_MAX_RETRIES_PER_REQUEST,
    } = await import("../src/config.js");
    expect(CACHE_COMMAND_TIMEOUT_MS).toBe(2500);
    expect(CACHE_CONNECT_TIMEOUT_MS).toBe(3000);
    expect(CACHE_MAX_RETRIES_PER_REQUEST).toBe(2);
  });

  it("parses a valid custom command timeout", async () => {
    process.env.CACHE_COMMAND_TIMEOUT_MS = "1500";
    const { CACHE_COMMAND_TIMEOUT_MS } = await import("../src/config.js");
    expect(CACHE_COMMAND_TIMEOUT_MS).toBe(1500);
  });

  it("falls back to the default on a non-numeric value (never NaN)", async () => {
    process.env.CACHE_COMMAND_TIMEOUT_MS = "not-a-number";
    const { CACHE_COMMAND_TIMEOUT_MS } = await import("../src/config.js");
    expect(CACHE_COMMAND_TIMEOUT_MS).toBe(2500);
    expect(Number.isNaN(CACHE_COMMAND_TIMEOUT_MS)).toBe(false);
  });

  it("falls back to the default on a non-positive value", async () => {
    process.env.CACHE_COMMAND_TIMEOUT_MS = "0";
    const { CACHE_COMMAND_TIMEOUT_MS } = await import("../src/config.js");
    expect(CACHE_COMMAND_TIMEOUT_MS).toBe(2500);
  });
});

describe("HTTP session lifecycle knobs", () => {
  it("defaults idle timeout to 600000ms and max sessions to 256", async () => {
    const { HTTP_SESSION_IDLE_TIMEOUT_MS, HTTP_MAX_SESSIONS } = await import(
      "../src/config.js"
    );
    expect(HTTP_SESSION_IDLE_TIMEOUT_MS).toBe(600_000);
    expect(HTTP_MAX_SESSIONS).toBe(256);
  });

  it("parses custom values", async () => {
    process.env.HTTP_SESSION_IDLE_TIMEOUT_MS = "120000";
    process.env.HTTP_MAX_SESSIONS = "8";
    const { HTTP_SESSION_IDLE_TIMEOUT_MS, HTTP_MAX_SESSIONS } = await import(
      "../src/config.js"
    );
    expect(HTTP_SESSION_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(HTTP_MAX_SESSIONS).toBe(8);
  });
});

describe("URL trailing-slash normalization for KIWIX_URL/HISTER_URL", () => {
  it("strips a trailing slash from KIWIX_URL", async () => {
    process.env.KIWIX_URL = "http://kiwix:8080/";
    const { KIWIX_URL } = await import("../src/config.js");
    expect(KIWIX_URL).toBe("http://kiwix:8080");
  });

  it("defaults KIWIX_URL to empty string when unset", async () => {
    const { KIWIX_URL } = await import("../src/config.js");
    expect(KIWIX_URL).toBe("");
  });

  it("strips a trailing slash from HISTER_URL", async () => {
    process.env.HISTER_URL = "http://hister:8123/";
    const { HISTER_URL } = await import("../src/config.js");
    expect(HISTER_URL).toBe("http://hister:8123");
  });

  it("defaults HISTER_URL to empty string when unset", async () => {
    const { HISTER_URL } = await import("../src/config.js");
    expect(HISTER_URL).toBe("");
  });
});
