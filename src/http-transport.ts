import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message },
      id: null,
    }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/**
 * Builds a Node HTTP request listener that routes each request to the
 * StreamableHTTPServerTransport for its MCP session. A new transport (and
 * MCP server, via `createServer`) is instantiated per session and keyed by
 * the Mcp-Session-Id header, per the SDK's documented stateful multi-session
 * pattern — a single shared transport rejects every session after the first.
 */
export function createHttpRequestListener(
  createServer: () => McpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return (req, res) => {
    void (async () => {
      try {
        const sessionId = req.headers["mcp-session-id"];
        const existing =
          typeof sessionId === "string" ? transports.get(sessionId) : undefined;

        if (existing) {
          await existing.handleRequest(req, res);
          return;
        }

        if (typeof sessionId === "string") {
          sendJsonRpcError(res, 404, "Session not found");
          return;
        }

        const parsedBody =
          req.method === "POST" ? await readJsonBody(req) : undefined;

        if (!isInitializeRequest(parsedBody)) {
          sendJsonRpcError(res, 400, "No valid session ID provided");
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } catch (err: unknown) {
        console.error("[searxng-mcp] HTTP transport error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    })();
  };
}
