import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

// /health pings Valkey; stub only that so these tests need no cache backend.
// The auth check itself is never stubbed — every case below drives the real
// listener with the real config constant. tests/domain-db.test.ts:171 is the
// cautionary example in this repo: stubbing the unit under test asserted a
// contract the implementation did not honour.
vi.mock("../src/cache.js", () => ({ cachePing: async () => true }));

const TOKEN = "a".repeat(64);

let httpServer: Server | undefined;

/**
 * Start a listener with SEARXNG_MCP_AUTH_TOKEN set to `token` (or unset when
 * undefined). Modules are re-imported after resetModules so config.ts re-reads
 * the environment — including the SDK, so transports and McpServer come from a
 * single module graph.
 */
async function startWithToken(token: string | undefined): Promise<number> {
  if (token === undefined) delete process.env.SEARXNG_MCP_AUTH_TOKEN;
  else process.env.SEARXNG_MCP_AUTH_TOKEN = token;

  vi.resetModules();
  const [{ createHttpRequestListener }, { McpServer }] = await Promise.all([
    import("../src/http-transport.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
  ]);

  const server = createServer(
    createHttpRequestListener(
      () => new McpServer({ name: "test-server", version: "0.0.0" }),
    ),
  );
  httpServer = server;
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  delete process.env.SEARXNG_MCP_AUTH_TOKEN;
  const server = httpServer;
  httpServer = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
});

function initialize(port: number, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: INITIALIZE,
  });
}

describe("HTTP transport auth — token unset (default)", () => {
  it("leaves /mcp open, so stdio users and loopback deployments are unaffected", async () => {
    const port = await startWithToken(undefined);
    const res = await initialize(port);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("does not send a WWW-Authenticate challenge on a malformed request", async () => {
    const port = await startWithToken(undefined);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    });
    // 400 "No valid session ID provided" — the pre-auth behaviour, unchanged.
    expect(res.status).toBe(400);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

describe("HTTP transport auth — token set", () => {
  it("rejects a request with no Authorization header", async () => {
    const port = await startWithToken(TOKEN);
    const res = await initialize(port);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("rejects a wrong token", async () => {
    const port = await startWithToken(TOKEN);
    const res = await initialize(port, {
      Authorization: `Bearer ${"b".repeat(64)}`,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a token of the right prefix but the wrong length", async () => {
    // The comparison hashes both sides, so a length mismatch must be a plain
    // 401 — never an unhandled timingSafeEqual throw surfacing as a 500.
    const port = await startWithToken(TOKEN);
    for (const wrong of ["a".repeat(63), "a".repeat(65), "a"]) {
      const res = await initialize(port, { Authorization: `Bearer ${wrong}` });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a non-Bearer scheme and a Bearer header with no credentials", async () => {
    const port = await startWithToken(TOKEN);
    for (const header of [TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer "]) {
      const res = await initialize(port, { Authorization: header });
      expect(res.status).toBe(401);
    }
  });

  it("accepts the correct token and establishes a session", async () => {
    const port = await startWithToken(TOKEN);
    const res = await initialize(port, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("treats the Bearer scheme name as case-insensitive (RFC 7235)", async () => {
    const port = await startWithToken(TOKEN);
    const res = await initialize(port, { Authorization: `bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("gates established sessions too, not just session creation", async () => {
    // The check sits ahead of session routing. If it were placed after, a
    // caller who learned a session ID could drive it with no credentials.
    const port = await startWithToken(TOKEN);
    const created = await initialize(port, {
      Authorization: `Bearer ${TOKEN}`,
    });
    const sessionId = created.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId as string },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("does not echo the presented credential in the response", async () => {
    const presented = "c".repeat(64);
    const port = await startWithToken(TOKEN);
    const res = await initialize(port, {
      Authorization: `Bearer ${presented}`,
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(presented);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(String(presented.length));
  });

  it("leaves GET /health unauthenticated — it is the container healthcheck", async () => {
    const port = await startWithToken(TOKEN);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", cache: "up" });
  });
});
