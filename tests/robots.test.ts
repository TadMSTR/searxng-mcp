import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import { checkRobots } from "../src/robots.js";

const cacheGetMock = vi.mocked(cacheGet);
const cacheSetMock = vi.mocked(cacheSet);

describe("checkRobots", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    cacheSetMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows when origin returns no robots.txt", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 404 }) as Response,
    );
    const result = await checkRobots("https://example.com/page", "searxng-mcp");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_robots_txt");
  });

  it("disallows when robots.txt blocks the user-agent", async () => {
    const body = `User-agent: searxng-mcp\nDisallow: /private/\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/private/secret",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("disallowed");
  });

  it("allows paths not covered by Disallow", async () => {
    const body = `User-agent: searxng-mcp\nDisallow: /private/\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/public",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(true);
  });

  it("applies User-agent: * when no specific match", async () => {
    const body = `User-agent: *\nDisallow: /\n`;
    cacheGetMock.mockResolvedValue(
      JSON.stringify({ body, fetched: "2026-05-17T00:00:00Z" }),
    );
    const result = await checkRobots(
      "https://example.com/anything",
      "searxng-mcp",
    );
    expect(result.allowed).toBe(false);
  });

  it("allows on malformed URL input rather than throwing", async () => {
    const result = await checkRobots("not-a-url", "searxng-mcp");
    expect(result.allowed).toBe(true);
  });

  it("caches a fresh fetch result", async () => {
    cacheGetMock.mockResolvedValue(null);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("User-agent: *\nAllow: /\n", { status: 200 }) as Response,
    );
    await checkRobots("https://example.com/x", "searxng-mcp");
    expect(cacheSetMock).toHaveBeenCalled();
    const [, _value, ttl] = cacheSetMock.mock.calls[0];
    expect(ttl).toBe(24 * 60 * 60);
  });
});
