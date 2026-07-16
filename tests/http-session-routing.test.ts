import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpRequestListener } from "../src/http-transport.js";

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

describe("HTTP session routing", () => {
  it("gives two concurrent clients distinct sessions instead of rejecting the second", async () => {
    const [resA, resB] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(initializeRequest(1)),
      }),
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(initializeRequest(2)),
      }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const sessionA = resA.headers.get("mcp-session-id");
    const sessionB = resB.headers.get("mcp-session-id");

    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionA).not.toBe(sessionB);
  });

  it("rejects a request carrying an unknown session ID with 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { ...MCP_HEADERS, "mcp-session-id": "not-a-real-session" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-initialize request without a session ID with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    expect(res.status).toBe(400);
  });
});
