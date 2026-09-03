#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logCapabilities } from "./capabilities.js";
import {
  HTTP_AUTH_TOKEN,
  HTTP_HOST,
  HTTP_PORT,
  isLoopbackHost,
  TRANSPORT,
} from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { logError, logWarn } from "./log.js";
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
// After both inits so the OTel/NATS entries report what actually got wired,
// and before transport setup so the line is present even if the transport
// fails to come up.
logCapabilities();

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
    // The misconfiguration this whole transport-auth feature exists to prevent:
    // reachable off-host with nothing checking credentials. Make it loud rather
    // than leaving it to be discovered by an audit.
    if (!isLoopbackHost(HTTP_HOST) && HTTP_AUTH_TOKEN === "") {
      logWarn(
        `WARNING: bound to ${HTTP_HOST}:${HTTP_PORT}, which is not loopback, with SEARXNG_MCP_AUTH_TOKEN unset — every tool is reachable unauthenticated, including arbitrary-URL fetch_url and destructive clear_cache. Set SEARXNG_MCP_AUTH_TOKEN.`,
      );
    }
    if (HTTP_AUTH_TOKEN !== "" && HTTP_AUTH_TOKEN.length < 32) {
      logWarn(
        "WARNING: SEARXNG_MCP_AUTH_TOKEN is shorter than 32 characters — generate one with `openssl rand -hex 32`.",
      );
    }
  });
} else {
  const server = createSearxngServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
