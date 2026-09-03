/**
 * Failover against REAL HTTP servers, not a mocked `fetch`.
 *
 * forge runs exactly one SearXNG container, so preflight called for a stub
 * returning valid SearXNG JSON rather than skipping the multi-instance test.
 * That stub is `startStubSearxng` below: a `node:http` server that answers
 * `/search` with a real SearXNG-shaped JSON body.
 *
 * This covers what the mocked-fetch suite cannot:
 *   - a genuinely refused connection (real ECONNREFUSED, not a synthetic throw)
 *   - real `AbortSignal.timeout` interaction with a real socket
 *   - the actual URL the client builds, observed at the server end
 *   - real JSON parsing of a real response body
 *
 * Ports are bound with 0 so the OS assigns them. Picking a port and checking it
 * is free beforehand is not a reservation — something can take it in between.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SEARX_BODY = {
  query: "q",
  results: [
    {
      title: "Stub result",
      url: "https://example.com/stub",
      content: "from the stub instance",
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
  paths: string[];
  close: () => Promise<void>;
}

/** A real HTTP server answering /search with valid SearXNG JSON. */
async function startStubSearxng(
  handler?: (path: string) => { status: number; body?: unknown } | undefined,
): Promise<Stub> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    const override = handler?.(req.url ?? "");
    if (override) {
      res.writeHead(override.status, { "content-type": "application/json" });
      res.end(JSON.stringify(override.body ?? {}));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(SEARX_BODY));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("stub failed to bind");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A URL with nothing listening: bind to get a port, then release it. */
async function deadUrl(): Promise<string> {
  const s = await startStubSearxng();
  const url = s.url;
  await s.close();
  return url;
}

const ENV = [
  "SEARXNG_URL",
  "SEARXNG_TOTAL_TIMEOUT_MS",
  "SEARXNG_ATTEMPT_TIMEOUT_MS",
];

function clearEnv() {
  for (const k of ENV) delete process.env[k];
}

async function loadSearch() {
  vi.doMock("../../src/cache.js", () => ({
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn().mockResolvedValue(undefined),
    searchCacheKey: vi.fn().mockReturnValue("k"),
    getValkey: vi.fn().mockResolvedValue(null),
    cacheClear: vi.fn(),
    cacheAtomicUpdate: vi.fn(),
  }));
  vi.doMock("../../src/observability.js", () => ({
    withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
    incCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }));
  const searxFailover = vi.fn();
  vi.doMock("../../src/events.js", () => ({
    events: new Proxy(
      { searxFailover },
      { get: (t, p) => (p in t ? t[p as "searxFailover"] : vi.fn()) },
    ),
  }));
  const { searxSearchSingle } = await import("../../src/search.js");
  return { searxSearchSingle, searxFailover };
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});
afterEach(clearEnv);

describe("failover against real SearXNG stubs", () => {
  it("single live instance returns its results", async () => {
    const live = await startStubSearxng();
    process.env.SEARXNG_URL = live.url;

    const { searxSearchSingle } = await loadSearch();
    const out = await searxSearchSingle("q", "general", 5);

    expect(out.results[0].title).toBe("Stub result");
    expect(live.paths).toHaveLength(1);
    expect(live.paths[0]).toContain("/search?");
    await live.close();
  });

  it("[dead, live] recovers over a real refused connection", async () => {
    const dead = await deadUrl();
    const live = await startStubSearxng();
    process.env.SEARXNG_URL = `${dead},${live.url}`;

    const { searxSearchSingle, searxFailover } = await loadSearch();
    const out = await searxSearchSingle("q", "general", 5);

    expect(out.results[0].url).toBe("https://example.com/stub");
    expect(live.paths).toHaveLength(1);
    expect(searxFailover).toHaveBeenCalledTimes(1);
    expect(searxFailover.mock.calls[0][0]).toMatchObject({
      from: dead,
      to: live.url,
      exhausted: false,
    });
    await live.close();
  });

  it("[live, dead] never opens a connection to the dead instance", async () => {
    const live = await startStubSearxng();
    const dead = await deadUrl();
    process.env.SEARXNG_URL = `${live.url},${dead}`;

    const { searxSearchSingle, searxFailover } = await loadSearch();
    await searxSearchSingle("q", "general", 5);

    expect(live.paths).toHaveLength(1);
    expect(searxFailover).not.toHaveBeenCalled();
    await live.close();
  });

  it("fails over from a real 502 to a healthy replica", async () => {
    const bad = await startStubSearxng(() => ({
      status: 502,
      body: { error: "bad gateway" },
    }));
    const live = await startStubSearxng();
    process.env.SEARXNG_URL = `${bad.url},${live.url}`;

    const { searxSearchSingle } = await loadSearch();
    const out = await searxSearchSingle("q", "general", 5);

    expect(out.results[0].title).toBe("Stub result");
    expect(bad.paths).toHaveLength(1);
    expect(live.paths).toHaveLength(1);
    await bad.close();
    await live.close();
  });

  it("forwards the query and category to the instance that serves it", async () => {
    // Proves failover hands the SAME request on, rather than a degraded one.
    const dead = await deadUrl();
    const live = await startStubSearxng();
    process.env.SEARXNG_URL = `${dead},${live.url}`;

    const { searxSearchSingle } = await loadSearch();
    await searxSearchSingle("nginx reverse proxy", "it", 5, "month");

    const params = new URLSearchParams(live.paths[0].split("?")[1]);
    expect(params.get("q")).toBe("nginx reverse proxy");
    expect(params.get("categories")).toBe("it");
    expect(params.get("time_range")).toBe("month");
    expect(params.get("format")).toBe("json");
    await live.close();
  });

  it("throws when every real instance is dead", async () => {
    process.env.SEARXNG_URL = `${await deadUrl()},${await deadUrl()}`;
    const { searxSearchSingle, searxFailover } = await loadSearch();

    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow();
    expect(searxFailover).toHaveBeenCalledTimes(2);
    expect(searxFailover.mock.calls[1][0]).toMatchObject({ exhausted: true });
  });

  it("respects the total budget against instances that hang", async () => {
    // A hung socket, not a refused one — this is the case the shared deadline
    // exists for, and the one a per-instance timeout would multiply.
    const hang1 = createServer(() => {
      /* accept and never respond */
    });
    const hang2 = createServer(() => {});
    await new Promise<void>((r) => hang1.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => hang2.listen(0, "127.0.0.1", r));
    const p1 = (hang1.address() as { port: number }).port;
    const p2 = (hang2.address() as { port: number }).port;

    process.env.SEARXNG_URL = `http://127.0.0.1:${p1},http://127.0.0.1:${p2}`;
    process.env.SEARXNG_TOTAL_TIMEOUT_MS = "400";
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = "300";

    const { searxSearchSingle } = await loadSearch();
    const t0 = Date.now();
    await expect(searxSearchSingle("q", "general", 5)).rejects.toThrow();
    const elapsed = Date.now() - t0;

    // 2 x 300ms unbudgeted would be ~600ms; the budget caps it at 400ms.
    expect(elapsed).toBeLessThan(560);
    expect(elapsed).toBeGreaterThanOrEqual(350);

    hang1.closeAllConnections();
    hang2.closeAllConnections();
    await new Promise<void>((r) => hang1.close(() => r()));
    await new Promise<void>((r) => hang2.close(() => r()));
  });
});
