#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HTTP_HOST, HTTP_PORT, TRANSPORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";

await initObservability();
await initEvents();

const server = new McpServer({
  name: "searxng-mcp",
  version: "3.10.0",
});

registerTools(server);

const shutdown = async () => {
  await Promise.allSettled([shutdownObservability(), shutdownEvents()]);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

if (TRANSPORT === "http") {
  // Stateful HTTP transport — session IDs prevent message ID collisions between
  // concurrent clients. Multiple clients share in-process caches (L1 llms.txt,
  // domain stats) but have separate Valkey-backed state.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    transport.handleRequest(req, res).catch((err: unknown) => {
      console.error("[searxng-mcp] HTTP transport error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  });

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(
      `[searxng-mcp] HTTP transport listening on http://${HTTP_HOST}:${HTTP_PORT}`,
    );
    if (HTTP_HOST !== "127.0.0.1") {
      console.error(
        `[searxng-mcp] WARNING: HTTP transport bound to ${HTTP_HOST}:${HTTP_PORT} — no built-in auth; ensure network-level protection`,
      );
    }
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
