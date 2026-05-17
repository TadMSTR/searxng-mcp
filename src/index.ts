#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initEvents, shutdownEvents } from "./events.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";

await initObservability();
await initEvents();

const server = new McpServer({
  name: "searxng-mcp",
  version: "3.5.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await Promise.allSettled([shutdownObservability(), shutdownEvents()]);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
