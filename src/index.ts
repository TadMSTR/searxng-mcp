#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTP_HOST, HTTP_PORT, TRANSPORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";

await initObservability();
await initEvents();

const createSearxngServer = () => {
  const server = new McpServer({
    name: "searxng-mcp",
    version: "3.10.0",
  });
  registerTools(server);
  return server;
};

const shutdown = async () => {
  await Promise.allSettled([shutdownObservability(), shutdownEvents()]);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

if (TRANSPORT === "http") {
  // Stateful HTTP transport — each MCP session gets its own transport (and
  // server) instance, keyed by Mcp-Session-Id, so concurrent clients don't
  // collide on a single shared transport. Multiple clients share in-process
  // caches (L1 llms.txt, domain stats) but have separate Valkey-backed state.
  const httpServer = createServer(
    createHttpRequestListener(createSearxngServer),
  );

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
  const server = createSearxngServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
