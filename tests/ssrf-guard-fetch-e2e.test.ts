// The SSRF guard as production uses it: ssrfGuardedDispatcher, an npm-undici
// Agent, passed as `dispatcher` to Node's BUILT-IN fetch. No mocks.
//
// Node's fetch is its own bundled copy of undici, and which major it bundles
// changes with the Node line (CI runs this on Node 22 and 24). If a Node or
// undici upgrade stopped the built-in fetch from honouring an npm-undici Agent,
// every guarded fetch would silently lose its connect-time DNS check while the
// unit tests of makeGuardedLookup stayed green. These tests fail in that case:
// the request would reach the local server.
//
// `localhost` is used because it is a name: the guard sits in the dispatcher's
// connect-time lookup, and an IP literal never goes through a lookup.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ssrfGuardedDispatcher } from "../src/ssrf-guard.js";

let server: Server;
let port: number;
let hits: string[];

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${port}/target` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("reached");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function failureChain(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const parts: string[] = [];
    let e: unknown = err;
    for (let i = 0; e && i < 5; i++) {
      parts.push(
        `${(e as Error).name}: ${(e as Error).message} ${(e as NodeJS.ErrnoException).code ?? ""}`,
      );
      e = (e as { cause?: unknown }).cause;
    }
    return parts.join(" <- ");
  }
  return "no error";
}

describe("ssrfGuardedDispatcher through the built-in fetch", () => {
  it("control: without the guard, localhost is reached", async () => {
    const res = await fetch(`http://localhost:${port}/direct`);
    expect(await res.text()).toBe("reached");
    expect(hits).toEqual(["/direct"]);
  });

  it("refuses a name that resolves to loopback, before any request is sent", async () => {
    const chain = await failureChain(
      fetch(`http://localhost:${port}/guarded`, {
        dispatcher: ssrfGuardedDispatcher,
      } as RequestInit),
    );
    expect(chain).toMatch(/SsrfBlocked|private|reserved/i);
    expect(hits).toEqual([]);
  });

  it("re-checks a redirect hop: a 302 to a loopback name is refused", async () => {
    // The first hop is an IP literal, which the dispatcher's lookup never
    // sees (in production the string-level assertPublicUrl refuses it first).
    // The redirect target is a name, so the hop goes through the guard.
    const chain = await failureChain(
      fetch(`http://127.0.0.1:${port}/redirect`, {
        dispatcher: ssrfGuardedDispatcher,
      } as RequestInit),
    );
    expect(chain).toMatch(/SsrfBlocked|private|reserved/i);
    expect(hits).toEqual(["/redirect"]);
  });
});
