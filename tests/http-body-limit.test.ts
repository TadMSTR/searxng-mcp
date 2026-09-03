import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cachePing: async () => true,
}));

const { createHttpRequestListener } = await import("../src/http-transport.js");
const { HTTP_MAX_BODY_BYTES } = await import("../src/config.js");

let httpServer: Server;
let port: number;
beforeAll(async () => {
  const listener = createHttpRequestListener(
    () => new McpServer({ name: "test-server", version: "0.0.0" }),
  );
  httpServer = createServer(listener);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

const url = () => `http://127.0.0.1:${port}/mcp`;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

describe("HTTP transport request-body limit (vikunja#423)", () => {
  it("rejects an oversized POST body with 413", async () => {
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(HTTP_MAX_BODY_BYTES + 4096) },
    });

    const res = await fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("too large");
  }, 30_000);

  it("leaves a normal initialize unaffected", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE),
    });

    // The transport answers initialize with 200 and issues a session id. The
    // point is only that a normal payload is not caught by the new limit.
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  }, 30_000);

  it("accepts a body just under the limit, so the cap is not off by an order of magnitude", async () => {
    // Sized to land under the cap once JSON.stringify's own overhead is
    // counted. If this ever 413s, the limit moved or the accounting drifted.
    const padding = "x".repeat(HTTP_MAX_BODY_BYTES - 4096);
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ ...INITIALIZE, params: { padding } }),
    });

    // Not an initialize request once params are replaced, so the transport
    // answers 400 — but it got past the body read, which is what is asserted.
    expect(res.status).not.toBe(413);
  }, 30_000);

  it("the server survives an oversized request and still serves the next one", async () => {
    // The 413 path destroys the connection. Verify that tears down only that
    // request: this is a long-lived process shared by every agent, so a
    // rejected body must not take the listener with it.
    await fetch(url(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(HTTP_MAX_BODY_BYTES + 4096),
    }).catch(() => undefined);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 30_000);
});

describe("the bearer gate runs before the body is read", () => {
  // This is the test behind vikunja#423's corrected severity. The ticket read
  // as an unauthenticated DoS; it is not, because the auth check at
  // http-transport.ts precedes readJsonBody, so an unauthenticated caller
  // never gets a byte of its body buffered. That ordering is the entire
  // difference between "exposure" and "robustness", and prose in a CHANGELOG
  // does not keep it true.
  let authServer: Server | undefined;

  afterAll(async () => {
    delete process.env.SEARXNG_MCP_AUTH_TOKEN;
    const s = authServer;
    authServer = undefined;
    if (s) {
      await new Promise<void>((resolve, reject) =>
        s.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("answers 401, not 413, when an unauthenticated caller sends an oversized body", async () => {
    process.env.SEARXNG_MCP_AUTH_TOKEN = "a".repeat(64);
    vi.resetModules();
    const [{ createHttpRequestListener: makeListener }, { McpServer: Srv }] =
      await Promise.all([
        import("../src/http-transport.js"),
        import("@modelcontextprotocol/sdk/server/mcp.js"),
      ]);
    const { HTTP_MAX_BODY_BYTES: limit } = await import("../src/config.js");

    const s = createServer(
      makeListener(() => new Srv({ name: "test-server", version: "0.0.0" })),
    );
    authServer = s;
    await new Promise<void>((resolve) =>
      s.listen(0, "127.0.0.1", () => resolve()),
    );
    const p = (s.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${p}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(limit + 4096),
    });

    // 401 means the request was refused before its body mattered. A 413 here
    // would mean the body had been read first, which is the shape the ticket
    // assumed.
    expect(res.status).toBe(401);
  }, 30_000);
});

describe("the 413 answers completely, then stops reading the rest of the body", () => {
  it("delivers a complete, parseable 413 body", async () => {
    // This is what moving req.destroy() into res.end()'s completion callback
    // protects: tearing the socket down while the response is still buffered
    // would replace the error with a bare reset. Today's payload flushes
    // synchronously so this passes either way — the callback is what stops
    // that from being a property of the payload size rather than of the code.
    const res = await fetch(url(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(HTTP_MAX_BODY_BYTES + 4096),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { message: "Request body too large" },
    });
  }, 30_000);

  it("stops accepting the request body instead of draining it to completion", async () => {
    // Asserts the property, and is honest about what it can attribute. Two
    // things were tried first and are recorded so nobody re-derives them:
    //
    //   - "the socket was destroyed" is vacuous. The 413 sets
    //     `Connection: close`, so Node tears the socket down whether or not
    //     req.destroy() ever runs.
    //   - so is anything aimed at req.destroy() specifically. Removing that
    //     call entirely leaves this test green: `Connection: close` alone
    //     already stops the read. The destroy is defence-in-depth against that
    //     header changing, not the mechanism, and no test here can isolate it.
    //
    // What IS worth pinning is the user-visible behaviour vikunja#423 is about:
    // an oversized body is refused rather than drained to completion. Declare a
    // body far larger than the cap, trickle it, and measure how much the server
    // took before it stopped.
    const DECLARED = HTTP_MAX_BODY_BYTES * 64;
    const CHUNK = Buffer.alloc(64 * 1024, "x");

    const written = await new Promise<number>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${DECLARED}\r\n\r\n`,
        );
        pump();
      });

      let sent = 0;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        sock.destroy();
        resolve(sent);
      };

      const pump = () => {
        while (sent < DECLARED) {
          if (sock.destroyed || sock.writableEnded) return done();
          sent += CHUNK.byteLength;
          if (!sock.write(CHUNK)) {
            sock.once("drain", pump);
            return;
          }
        }
        done();
      };

      sock.on("error", done);
      sock.on("close", done);
      // Backstop so a server that never stops reading fails on the assertion
      // below rather than hanging the suite.
      setTimeout(done, 10_000);
    });

    // Deliberately generous. The server accepts the 1 MB cap plus whatever the
    // client already pushed into socket buffers — measured around 4 MB, and
    // that overshoot is a property of the kernel, not of this code. Asserting
    // "<= the cap" would be flaky for the same reason the fetch-side bound is
    // on bytes retained rather than bytes transferred. A quarter of a 64 MB
    // declared body sits far above the observed overshoot and far below
    // draining to completion, which is the only distinction that matters.
    expect(written).toBeLessThan(DECLARED / 4);
  }, 30_000);
});
