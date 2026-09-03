/**
 * Credentialed `SEARXNG_URL`, exercised against REAL `fetch` and REAL servers.
 *
 * This file exists because the previous credential test mocked `fetch` to
 * reject with `new Error("ECONNREFUSED")` — a synthetic message that never
 * contains a URL. It asserted the right property against the wrong failure
 * shape, and so it passed while the real behaviour leaked.
 *
 * What the mock could not reproduce: the WHATWG Fetch spec forbids building a
 * request from a URL containing userinfo, and Node enforces it synchronously,
 * before any network I/O:
 *
 *     TypeError: Request cannot be constructed from a URL that includes
 *     credentials: http://user:pw@host/search?q=x
 *
 * The password is in the error's OWN message. So every sink that forwards
 * `err.message` leaked it, and — separately — a credentialed instance could
 * never have served a single search.
 *
 * NOTHING IN THIS FILE MOCKS `fetch`. That is the point of it.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "hunter2";
const USER = "searxuser";

const SEARX_BODY = {
  query: "q",
  results: [
    {
      title: "Authenticated result",
      url: "https://example.com/authed",
      content: "served behind basic auth",
      engines: ["stub"],
    },
  ],
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

interface Stub {
  url: string;
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** A real server that records the Authorization header it was sent. */
async function startAuthStub(requireAuth = true): Promise<Stub> {
  const authHeaders: (string | undefined)[] = [];
  const expected = `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}`;
  const server: Server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    if (requireAuth && req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(SEARX_BODY));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("bind failed");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    authHeaders,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A port with nothing listening, so a real connection is refused. */
async function deadPort(): Promise<number> {
  const s = await startAuthStub();
  const port = Number(new URL(s.url).port);
  await s.close();
  return port;
}

const ENV = ["SEARXNG_URL", "SEARXNG_TOTAL_TIMEOUT_MS"];
const clearEnv = () => {
  for (const k of ENV) delete process.env[k];
};

async function loadSearch() {
  vi.doMock("../../src/cache.js", () => ({
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn().mockResolvedValue(undefined),
    searchCacheKey: vi.fn().mockReturnValue("k"),
    getValkey: vi.fn().mockResolvedValue(null),
    cacheClear: vi.fn(),
    cacheAtomicUpdate: vi.fn(),
  }));
  const searxFailover = vi.fn();
  const errorEvent = vi.fn();
  vi.doMock("../../src/events.js", () => ({
    events: new Proxy(
      { searxFailover, error: errorEvent },
      {
        get: (t, p) => (p in t ? t[p as "searxFailover" | "error"] : vi.fn()),
      },
    ),
  }));
  const { searxSearchSingle } = await import("../../src/search.js");
  return { searxSearchSingle, searxFailover, errorEvent };
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});
afterEach(clearEnv);

describe("credentialed SEARXNG_URL — real fetch", () => {
  it("ACTUALLY WORKS: credentials are sent as a header, and the search succeeds", async () => {
    // The regression this proves absent: with userinfo left in the URL, Node's
    // fetch refuses the request outright, so a credentialed instance could
    // never serve a search at all. This is the functional half of the fix.
    const stub = await startAuthStub();
    const { host } = new URL(stub.url);
    process.env.SEARXNG_URL = `http://${USER}:${SECRET}@${host}`;

    const { searxSearchSingle } = await loadSearch();
    const out = await searxSearchSingle("q", "general", 5);

    expect(out.results[0].title).toBe("Authenticated result");
    expect(stub.authHeaders).toHaveLength(1);
    expect(stub.authHeaders[0]).toBe(
      `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}`,
    );
    await stub.close();
  });

  it("percent-encoded credentials are decoded before being encoded", async () => {
    // A password containing '@' or ':' must be given as %40/%3A in the URL.
    // Base64-ing the still-encoded form would send the wrong secret.
    const pass = "p@ss:word";
    const stubPass = encodeURIComponent(pass);
    const authHeaders: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SEARX_BODY));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.SEARXNG_URL = `http://${USER}:${stubPass}@127.0.0.1:${port}`;

    const { searxSearchSingle } = await loadSearch();
    await searxSearchSingle("q", "general", 5);

    const decoded = Buffer.from(
      String(authHeaders[0]).replace("Basic ", ""),
      "base64",
    ).toString();
    expect(decoded).toBe(`${USER}:${pass}`);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("no credentials in the error thrown to the caller when the host is dead", async () => {
    const port = await deadPort();
    process.env.SEARXNG_URL = `http://${USER}:${SECRET}@127.0.0.1:${port}`;

    const { searxSearchSingle } = await loadSearch();
    let message = "";
    let ok = false;
    try {
      await searxSearchSingle("q", "general", 5);
      ok = true;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(ok).toBe(false);
    expect(message).not.toContain(SECRET);
  });

  it("no credentials in the generic error event, on the SINGLE-instance path", async () => {
    // `events.error` fires regardless of instance count, so the failover-only
    // redaction never runs here. This is the sink the original fix missed.
    const port = await deadPort();
    process.env.SEARXNG_URL = `http://${USER}:${SECRET}@127.0.0.1:${port}`;

    vi.doMock("../../src/observability.js", () => ({
      withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
      incCounter: vi.fn(),
      recordHistogram: vi.fn(),
    }));
    vi.doMock("../../src/reranker.js", () => ({
      rerankWithFallback: vi.fn().mockImplementation((_q, r) => r),
    }));
    const errorEvent = vi.fn();
    vi.doMock("../../src/events.js", () => ({
      events: new Proxy(
        { error: errorEvent },
        { get: (t, p) => (p in t ? t[p as "error"] : vi.fn()) },
      ),
    }));
    vi.doMock("../../src/cache.js", () => ({
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
      searchCacheKey: vi.fn().mockReturnValue("k"),
      getValkey: vi.fn().mockResolvedValue(null),
      cacheClear: vi.fn(),
      cacheAtomicUpdate: vi.fn(),
    }));

    const { handleSearch } = await import("../../src/tools.js");
    await expect(
      handleSearch({ query: "q", num_results: 3 }),
    ).rejects.toThrow();

    expect(errorEvent).toHaveBeenCalled();
    expect(JSON.stringify(errorEvent.mock.calls)).not.toContain(SECRET);
  });

  it("no credentials in the failover event or stderr line, multi-instance", async () => {
    const p1 = await deadPort();
    const p2 = await deadPort();
    process.env.SEARXNG_URL = `http://${USER}:${SECRET}@127.0.0.1:${p1},http://${USER}:${SECRET}@127.0.0.1:${p2}`;

    const { resetLogThrottle } = await import("../../src/log.js");
    resetLogThrottle();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { searxSearchSingle, searxFailover } = await loadSearch();
    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow();

    expect(searxFailover).toHaveBeenCalled();
    expect(JSON.stringify(searxFailover.mock.calls)).not.toContain(SECRET);

    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(SECRET);
    spy.mockRestore();
  });
});
