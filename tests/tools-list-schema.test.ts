/**
 * The published `tools/list` contract: every tool's name, description,
 * `inputSchema` and `outputSchema`, exactly as a client receives them.
 *
 * Agents and chat front ends never see the zod schemas in src/tools.ts. They
 * see the JSON Schema the SDK derives from them, and that derivation depends on
 * the zod major and on how a schema is built: a `z.preprocess` wrapper, for
 * one, can come out as an unconstrained `{}` that has lost its enum values,
 * default and description. A green unit suite says nothing about that, so this
 * file pins the derived output itself.
 *
 * The snapshot was first written on zod 3, before the zod 4 migration and the
 * empty-argument fix (#79), so any change to it since is a reviewed change.
 * When it fails: read the diff. Enum values, `default`s, `minimum`/`maximum` and
 * `description`s must survive; a structural change (for example `anyOf` in
 * place of a `type` array) is acceptable only when the commit that makes it
 * says why. Then update with `pnpm vitest run tests/tools-list-schema.test.ts -u`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools.js";

async function listTools() {
  const server = new McpServer({ name: "searxng-mcp", version: "test" });
  registerTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-list-snapshot", version: "test" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools/list published schemas", () => {
  it("matches the reviewed snapshot", async () => {
    const tools = await listTools();
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/tools-list.json",
    );
  });
});
