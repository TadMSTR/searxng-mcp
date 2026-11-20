// A caller-supplied traceparent is read only AFTER the bearer check. An
// unauthenticated request must be rejected without its headers ever reaching
// trace context, so it can't choose the trace its request is recorded under.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({ cachePing: async () => true }));

const remote = vi.hoisted(() => ({
  withRemoteParent: vi.fn((_h: unknown, fn: () => unknown) => fn()),
}));
vi.mock("../src/observability.js", () => remote);

const TOKEN = "b".repeat(64);
let httpServer: Server | undefined;

async function start(token: string = TOKEN): Promise<string> {
  vi.stubEnv("SEARXNG_MCP_AUTH_TOKEN", token);
  vi.resetModules();
  const [{ createHttpRequestListener }, { McpServer }] = await Promise.all([
    import("../src/http-transport.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
  ]);
  const server = createServer(
    createHttpRequestListener(() => new McpServer({ name: "t", version: "0" })),
  );
  httpServer = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  remote.withRemoteParent.mockClear();
  const s = httpServer;
  httpServer = undefined;
  if (s) await new Promise<void>((r) => s.close(() => r()));
});

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "c", version: "0" },
  },
});
const headers = (auth?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  traceparent: TRACEPARENT,
  ...(auth !== undefined && { Authorization: auth }),
});

describe("traceparent is read only after the bearer check", () => {
  it.each([
    ["no credentials", undefined],
    ["a wrong token", `Bearer ${"x".repeat(64)}`],
  ])("%s: 401 and the header is never read", async (_n, auth) => {
    const url = await start();
    const res = await fetch(url, {
      method: "POST",
      headers: headers(auth),
      body: INIT,
    });
    expect(res.status).toBe(401);
    expect(remote.withRemoteParent).not.toHaveBeenCalled();
  });

  it("an authenticated request passes its headers through (the control)", async () => {
    const url = await start();
    const res = await fetch(url, {
      method: "POST",
      headers: headers(`Bearer ${TOKEN}`),
      body: INIT,
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(remote.withRemoteParent).toHaveBeenCalledOnce();
    const passed = remote.withRemoteParent.mock.calls[0][0] as Record<
      string,
      string
    >;
    expect(passed.traceparent).toBe(TRACEPARENT);
  });
});

describe("with no SEARXNG_MCP_AUTH_TOKEN there is no bearer check", () => {
  // The documented rule (README "Trace context"): with no token configured the
  // transport is open, so any caller's traceparent is read. Pinned so the docs
  // and the code can't drift apart again.
  it("any caller's traceparent reaches withRemoteParent", async () => {
    const url = await start("");
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: INIT,
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(remote.withRemoteParent).toHaveBeenCalledOnce();
  });
});
