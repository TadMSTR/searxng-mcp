#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTP_HOST, HTTP_PORT, TRANSPORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { logError } from "./log.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

// This is a single long-lived HTTP process serving all agents. Before these
// handlers, a fault anywhere took searxng down for everyone with nothing logged
// — the 2026-07-16 crash-loop left 10 core dumps and zero log lines. Register
// before any init work so faults during startup are captured too.
process.on("uncaughtException", (err) => {
  logError(
    `FATAL uncaughtException — exiting for a clean PM2 restart: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  // Undefined process state after an uncaught throw — exit so PM2 restarts a
  // clean process rather than limping on. exit(1) marks it abnormal.
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // Log and keep running — an unhandled rejection is usually one degraded
  // request, not process-wide corruption. It is no longer silent, which is the
  // point. A genuinely fatal one will surface as an uncaughtException above.
  logError(
    `unhandledRejection (continuing): ${
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
    }`,
  );
});

await initObservability();
await initEvents();

const createSearxngServer = () => {
  const server = new McpServer({
    name: "searxng-mcp",
    version: VERSION,
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
