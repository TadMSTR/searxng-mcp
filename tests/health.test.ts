import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The /health route pings Valkey via cachePing; mock it so the test is
// deterministic regardless of whether a cache backend is reachable.
const h = vi.hoisted(() => ({ cacheUp: true }));
vi.mock("../src/cache.js", () => ({
  cachePing: async () => h.cacheUp,
}));

const { createHttpRequestListener } = await import("../src/http-transport.js");

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

describe("GET /health", () => {
  it("returns 200 ok when the cache pings", async () => {
    h.cacheUp = true;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", cache: "up" });
    expect(typeof body.sessions).toBe("number");
  });

  it("returns 503 degraded when the cache is unreachable", async () => {
    h.cacheUp = false;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", cache: "degraded" });
  });
});
