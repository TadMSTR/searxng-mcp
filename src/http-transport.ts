import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { cachePing } from "./cache.js";
import {
  HTTP_AUTH_TOKEN,
  HTTP_MAX_SESSIONS,
  HTTP_SESSION_IDLE_TIMEOUT_MS,
} from "./config.js";
import { logError, logThrottled, logWarn } from "./log.js";

const SESSION_SWEEP_INTERVAL_MS = 60_000;

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message },
      id: null,
    }),
  );
}

// RFC 6750 bearer credentials. The scheme name is case-insensitive (RFC 7235
// §2.1) and the token itself is a non-space run, so anything else is malformed
// and treated exactly like a missing header.
function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

// Compare SHA-256 digests rather than the raw tokens. timingSafeEqual throws on
// a length mismatch — guarding that with an explicit length check would work but
// reintroduces a length oracle and a 500 waiting to happen if the guard is ever
// dropped. Digests are always 32 bytes, so the comparison is constant-time and
// total for any input, including the empty string.
function tokenMatches(presented: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(HTTP_AUTH_TOKEN).digest(),
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
 *
 * Also serves an unauthenticated `GET /health` (cache liveness) and bounds the
 * session map so a client killed mid-turn (which never fires `transport.onclose`)
 * can't leak transports on this long-lived shared process.
 */
export function createHttpRequestListener(
  createServer: () => McpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastActivity = new Map<string, number>();
  // In-flight request count per session. `lastActivity` is stamped at request
  // start, so a single call that runs longer than the idle timeout (e.g. a large
  // crawl_site) would otherwise be swept mid-flight; a session with a request
  // in flight is never idle, so eviction skips it. Decremented in a `finally`
  // that also runs when the socket closes on an abrupt client disconnect, so a
  // genuinely leaked session still drops to zero and becomes evictable.
  const inFlight = new Map<string, number>();

  const touch = (sessionId: string): void => {
    lastActivity.set(sessionId, Date.now());
  };

  const isBusy = (sessionId: string): boolean =>
    (inFlight.get(sessionId) ?? 0) > 0;

  const forget = (sessionId: string): void => {
    lastActivity.delete(sessionId);
    inFlight.delete(sessionId);
  };

  const evict = (sessionId: string, reason: string): void => {
    const transport = transports.get(sessionId);
    forget(sessionId);
    if (!transport) return;
    logWarn(`evicting HTTP session ${sessionId} (${reason})`);
    // close() fires transport.onclose, which removes it from `transports`.
    void Promise.resolve(transport.close()).catch(() => {});
  };

  // Idle-session sweep. An agent killed mid-turn never fires transport.onclose,
  // so without this the map grows unbounded on a long-lived process. unref() so
  // it never keeps the process (or a test harness) alive on its own.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, ts] of lastActivity) {
      if (now - ts > HTTP_SESSION_IDLE_TIMEOUT_MS && !isBusy(sessionId)) {
        evict(sessionId, `idle ${Math.round((now - ts) / 1000)}s`);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  return (req, res) => {
    void (async () => {
      try {
        // Unauthenticated liveness probe. Pings Valkey through the bounded
        // command timeout so it can never itself hang; lets sysadmin monitoring
        // detect a degraded cache from the MCP side. No session required.
        if (
          req.method === "GET" &&
          (req.url === "/health" || req.url?.startsWith("/health?"))
        ) {
          const cacheUp = await cachePing();
          res.writeHead(cacheUp ? 200 : 503, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({
              status: cacheUp ? "ok" : "degraded",
              cache: cacheUp ? "up" : "degraded",
              sessions: transports.size,
            }),
          );
          return;
        }

        // Bearer gate. Off unless SEARXNG_MCP_AUTH_TOKEN is set, so stdio users
        // and existing loopback deployments keep today's behaviour exactly.
        // Placed after /health (the healthcheck must stay open) and before
        // session routing, so an unauthenticated caller can neither reach an
        // established session nor create one.
        if (HTTP_AUTH_TOKEN !== "") {
          const presented = bearerFrom(req.headers.authorization);
          if (presented === undefined || !tokenMatches(presented)) {
            // Identical response for missing, malformed and wrong credentials.
            // Never echo the presented token or its length. Throttled — this is
            // reachable by every co-tenant on the network, so an unthrottled
            // line per rejection lets a scanner flood the log.
            logThrottled(
              "http-auth-401",
              `rejected unauthenticated request: ${req.method} ${req.url}`,
            );
            sendJsonRpcError(res, 401, "Unauthorized", {
              "WWW-Authenticate": "Bearer",
            });
            return;
          }
        }

        const sessionId = req.headers["mcp-session-id"];
        const existing =
          typeof sessionId === "string" ? transports.get(sessionId) : undefined;

        if (existing && typeof sessionId === "string") {
          const sid = sessionId;
          touch(sid);
          inFlight.set(sid, (inFlight.get(sid) ?? 0) + 1);
          try {
            await existing.handleRequest(req, res);
          } finally {
            inFlight.set(sid, Math.max(0, (inFlight.get(sid) ?? 1) - 1));
            // Re-stamp on completion so idle is measured from last-activity-END,
            // not START — only if the session wasn't closed during the request.
            if (transports.has(sid)) touch(sid);
          }
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
            touch(id);
            // Hard-cap backstop in case the idle sweep can't keep up: evict the
            // least-recently-used session so the map can never grow without bound.
            if (transports.size > HTTP_MAX_SESSIONS) {
              let oldestId: string | undefined;
              let oldestTs = Number.POSITIVE_INFINITY;
              for (const [sid, ts] of lastActivity) {
                if (sid !== id && !isBusy(sid) && ts < oldestTs) {
                  oldestTs = ts;
                  oldestId = sid;
                }
              }
              if (oldestId) {
                evict(oldestId, `max sessions (${HTTP_MAX_SESSIONS}) exceeded`);
              }
            }
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            forget(transport.sessionId);
          }
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } catch (err: unknown) {
        logError(
          `HTTP transport error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    })();
  };
}
