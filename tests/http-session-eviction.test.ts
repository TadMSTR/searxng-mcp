import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Force a hard cap of 1 session so the LRU-eviction backstop fires on the
// second session. Env must be set before the config module is imported.
process.env.HTTP_MAX_SESSIONS = "1";

vi.mock("../src/cache.js", () => ({ cachePing: async () => true }));

const { createHttpRequestListener } = await import("../src/http-transport.js");

let httpServer: Server;
let port: number;
let nextId = 1;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

async function initSession(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(initializeRequest(nextId++)),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  return sid as string;
}

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

describe("HTTP session eviction (max-sessions backstop)", () => {
  it("evicts the least-recently-used session when the cap is exceeded", async () => {
    const sessionA = await initSession();
    // Opening a second session exceeds HTTP_MAX_SESSIONS=1 and evicts A (LRU).
    const sessionB = await initSession();
    expect(sessionB).not.toBe(sessionA);

    // Eviction closes A's transport asynchronously; give onclose a tick.
    await new Promise((r) => setTimeout(r, 150));

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionA },
    });
    expect(res.status).toBe(404);
  });

  it("does not evict a session with an in-flight request when the cap is exceeded", async () => {
    const sessionA = await initSession();

    // Hold an in-flight request open on A (a GET opens the long-lived SSE
    // stream, so its handler stays pending → inFlight[A] > 0).
    const ac = new AbortController();
    const held = fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionA },
      signal: ac.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    // Opening B exceeds the cap of 1, but A is busy so the LRU backstop must
    // skip it rather than close it mid-request.
    await initSession();
    await new Promise((r) => setTimeout(r, 150));

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    // A survived: a known session is routed (not the 404 an evicted one gets).
    expect(res.status).not.toBe(404);

    ac.abort();
    await held;
  });
});
