// adblock-proxy's filter loading and /health endpoint (docker/adblock-proxy/proxy.js).
//
// Three silent failures this pins:
// - the startup log printed "(undefined rules)": the count read a property the
//   engine does not have, so no log ever showed whether rules were loaded;
// - FiltersEngine.parse("") returns a valid empty engine, so a load where every
//   list failed was installed and reported as success;
// - a refresh replaced the engine unconditionally, so a refresh during an
//   upstream outage swapped a working rule set for an empty one.
//
// The real @ghostery/adblocker is used (a root devDependency pinned to the
// proxy's lockfile version; parity is asserted at the bottom), so the count and
// match calls are the ones the image runs.

import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);

interface ProxyState {
  engine: unknown;
  networkFilters: number;
  cosmeticFilters: number;
  loadedAt: string | null;
}
type FakeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};
type FetchImpl = (url: string, init?: unknown) => Promise<FakeResponse>;

const proxy = require_("../docker/adblock-proxy/proxy.js") as {
  createServer: () => http.Server;
  loadFilters: (opts?: {
    urls?: string[];
    fetchImpl?: FetchImpl;
  }) => Promise<boolean>;
  isBlocked: (url: string) => boolean;
  state: ProxyState;
};

// Two network filters, one cosmetic filter.
const FIXTURE =
  "! fixture list\n||ads.example.com^\n||tracker.example.net^\n##.banner\n";
const LIST = "https://lists.test/fixture.txt";

const serve =
  (body: string): FetchImpl =>
  async () => ({ ok: true, status: 200, text: async () => body });
const failing: FetchImpl = async () => {
  throw new Error("getaddrinfo ENOTFOUND lists.test");
};
const status503: FetchImpl = async () => ({
  ok: false,
  status: 503,
  text: async () => "",
});

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(proxy.state, {
    engine: null,
    networkFilters: 0,
    cosmeticFilters: 0,
    loadedAt: null,
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");

describe("loadFilters — counts", () => {
  it("logs real network and cosmetic counts, never 'undefined'", async () => {
    expect(
      await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) }),
    ).toBe(true);
    const out = logged(logSpy);
    expect(out).toMatch(
      /loaded 2 network and 1 cosmetic filters from 1\/1 list\(s\)/,
    );
    expect(out).toMatch(
      /fetched https:\/\/lists\.test\/fixture\.txt \(\d+ bytes\)/,
    );
    expect(out).not.toContain("undefined");
    expect(proxy.state.networkFilters).toBe(2);
    expect(proxy.state.cosmeticFilters).toBe(1);
  });

  it("counts a partial load from the lists that did arrive", async () => {
    const mixed: FetchImpl = async (url) =>
      url === LIST ? serve(FIXTURE)(url) : status503(url);
    expect(
      await proxy.loadFilters({
        urls: [LIST, "https://lists.test/down.txt"],
        fetchImpl: mixed,
      }),
    ).toBe(true);
    expect(logged(logSpy)).toMatch(/from 1\/2 list\(s\)/);
    expect(logged(errSpy)).toMatch(
      /filter fetch failed: https:\/\/lists\.test\/down\.txt status=503/,
    );
  });
});

describe("loadFilters — empty loads", () => {
  it("at startup, an all-fail load leaves no engine and warns", async () => {
    expect(await proxy.loadFilters({ urls: [LIST], fetchImpl: failing })).toBe(
      false,
    );
    expect(proxy.state.engine).toBeNull();
    expect(proxy.state.networkFilters).toBe(0);
    expect(logged(errSpy)).toMatch(
      /WARNING: no filters loaded \(0\/1 list\(s\) fetched\)/,
    );
    expect(proxy.isBlocked("http://ads.example.com/x.js")).toBe(false);
  });

  it("a failed refresh keeps the previous engine: a blocked URL stays blocked", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    const before = { ...proxy.state };
    expect(proxy.isBlocked("http://ads.example.com/x.js")).toBe(true);

    expect(await proxy.loadFilters({ urls: [LIST], fetchImpl: failing })).toBe(
      false,
    );

    expect(proxy.isBlocked("http://ads.example.com/x.js")).toBe(true);
    expect(proxy.state.engine).toBe(before.engine);
    expect(proxy.state.networkFilters).toBe(2);
    // The "last good load" time is not reset by a load that failed.
    expect(proxy.state.loadedAt).toBe(before.loadedAt);
    expect(logged(errSpy)).toMatch(
      /WARNING: refresh produced 0 network filters .* keeping the previous rule set \(2 network, 1 cosmetic/,
    );
  });

  it("a refresh that fetches only an empty or comment-only list is also refused", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    const engine = proxy.state.engine;
    // The fetch succeeds (200), so only the count can tell this from a good load.
    expect(
      await proxy.loadFilters({
        urls: [LIST],
        fetchImpl: serve("! nothing here\n"),
      }),
    ).toBe(false);
    expect(proxy.state.engine).toBe(engine);
    expect(proxy.isBlocked("http://tracker.example.net/t.gif")).toBe(true);
  });

  it("a good refresh replaces the engine", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    expect(
      await proxy.loadFilters({
        urls: [LIST],
        fetchImpl: serve("||other.example.org^\n"),
      }),
    ).toBe(true);
    expect(proxy.state.networkFilters).toBe(1);
    expect(proxy.isBlocked("http://ads.example.com/x.js")).toBe(false);
    expect(proxy.isBlocked("http://other.example.org/x.js")).toBe(true);
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

function request(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /health", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = proxy.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("is 200 with the counts once a rule set is loaded", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    const res = await request(port, "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      status: "ok",
      network_filters: 2,
      cosmetic_filters: 1,
      loaded_at: proxy.state.loadedAt,
    });
    expect(Number.isNaN(Date.parse(body.loaded_at))).toBe(false);
  });

  it("is 503 no_filters after an all-fail load", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: failing });
    const res = await request(port, "/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: "no_filters",
      network_filters: 0,
      cosmetic_filters: 0,
      loaded_at: null,
    });
  });

  it("stays 200 after a failed refresh", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    await proxy.loadFilters({ urls: [LIST], fetchImpl: failing });
    expect((await request(port, "/health")).status).toBe(200);
  });

  it("an absolute-form http://<internal>/health is proxied, so the SSRF guard refuses it", async () => {
    // The route matches only origin-form. If it matched on pathname, this
    // request would be answered locally today and a later change to the route
    // could forward it; either way it must take the proxy path.
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    const res = await request(port, "http://127.0.0.1/health");
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("network_filters");
  });

  it("other origin-form requests keep their behaviour (400)", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/health?verbose=1", "GET"],
      ["/health/", "GET"],
      ["/", "GET"],
      ["/health", "POST"],
    ] as const) {
      const res = await request(port, path, method);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body).toBe("");
    }
  });

  it("a blocked absolute-form URL still gets the empty 200", async () => {
    await proxy.loadFilters({ urls: [LIST], fetchImpl: serve(FIXTURE) });
    const res = await request(port, "http://ads.example.com/x.js");
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });
});

describe("dependency parity", () => {
  it("the root devDependency is the version the proxy image installs", () => {
    // The tests above exercise the root copy; the image runs the one in
    // docker/adblock-proxy/package-lock.json. Bump both together.
    const root = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const lock = JSON.parse(
      readFileSync(
        new URL("../docker/adblock-proxy/package-lock.json", import.meta.url),
        "utf8",
      ),
    );
    expect(root.devDependencies["@ghostery/adblocker"]).toBe(
      lock.packages["node_modules/@ghostery/adblocker"].version,
    );
  });
});
