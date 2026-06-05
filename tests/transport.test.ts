import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Minimal MCP server for transport tests — no tools, just verifies
// the HTTP transport can be instantiated and handle requests.

let httpServer: ReturnType<typeof createServer>;
let port: number;

beforeAll(async () => {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    transport.handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      process.stdout.write(`[transport-test] handleRequest error: ${msg}\n${stack}\n`);
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: msg })); }
    });
  });

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

// MCP Streamable HTTP transport requires Accept: application/json, text/event-stream
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("HTTP transport", () => {
  it("rejects requests missing the required Accept header with 406", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(406);
  });

  it("handles a valid JSON-RPC initialize request", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    const rawBody = await res.text();
    process.stdout.write(`[transport-test-debug] status=${res.status} ct=${res.headers.get("content-type")} body=${rawBody.slice(0, 300)}\n`);
    // The SDK may return 200 with SSE body or 200 with JSON body depending on Accept negotiation.
    // Accept both; just verify the response is well-formed.
    expect(res.status).toBe(200);
    // SSE body format: "event: message\ndata: {...}\n\n"
    // JSON body format: "{...}"
    expect(rawBody.length).toBeGreaterThan(0);
    // Either way, the response should contain the jsonrpc field
    expect(rawBody).toContain('"jsonrpc"');
    expect(rawBody).toContain('"result"');
  });
});
