"use strict";

/**
 * adblock-proxy — HTTP forward proxy with @ghostery/adblocker filter engine.
 *
 * Plain HTTP requests: checked against EasyList + EasyPrivacy. Blocked URLs
 * receive an empty 200 response. Allowed requests are proxied to the target.
 *
 * HTTPS CONNECT: established as a TCP tunnel without interception. HTTPS
 * ad/tracker domains are not filtered at content level (acceptable tradeoff
 * vs. certificate complexity — see docker/adblock-proxy/README.md).
 *
 * Environment:
 *   PORT                  Listen port (default: 8118)
 *   ADBLOCK_FILTERS_URL   Comma-separated filter list URLs
 *                         (default: EasyList + EasyPrivacy)
 *   ADBLOCK_REFRESH_HOURS How often to refresh filters (default: 168)
 *   LOG_BLOCKED           Log blocked request URLs (default: false)
 */

const http = require("http");
const net = require("net");
const { URL } = require("url");
const { FiltersEngine, Request } = require("@ghostery/adblocker");

const PORT = parseInt(process.env.PORT ?? "8118", 10);
const FILTERS_URLS = (
  process.env.ADBLOCK_FILTERS_URL ??
  "https://easylist.to/easylist/easylist.txt,https://easylist.to/easylist/easyprivacy.txt"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const REFRESH_HOURS = parseInt(process.env.ADBLOCK_REFRESH_HOURS ?? "168", 10);
const LOG_BLOCKED = process.env.LOG_BLOCKED === "true";

let engine = null;

async function loadFilters() {
  let combined = "";
  for (const url of FILTERS_URLS) {
    try {
      // Use global fetch (Node 18+)
      const res = await fetch(url, {
        headers: { "User-Agent": "adblock-proxy/1.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`[adblock-proxy] filter fetch failed: ${url} status=${res.status}`);
        continue;
      }
      const text = await res.text();
      combined += text + "\n";
    } catch (err) {
      console.error(`[adblock-proxy] filter fetch error: ${url} ${err.message}`);
    }
  }
  const newEngine = FiltersEngine.parse(combined, { debug: false });
  const count = newEngine.filters ? newEngine.filters.size : "unknown";
  engine = newEngine;
  console.log(`[adblock-proxy] loaded filters from ${FILTERS_URLS.length} list(s) (${count} rules)`);
}

function isBlocked(url, sourceUrl = "") {
  if (!engine) return false;
  try {
    const req = Request.fromRawDetails({ url, sourceUrl, type: "other" });
    return engine.match(req).match;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  // Plain HTTP proxy request
  const targetUrl = req.url;

  if (isBlocked(targetUrl)) {
    if (LOG_BLOCKED) console.log(`[adblock-proxy] blocked ${targetUrl}`);
    res.writeHead(200, { "Content-Length": "0", "Content-Type": "text/plain" });
    res.end();
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: { ...req.headers, host: parsed.host },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  req.pipe(proxy, { end: true });
});

// HTTPS CONNECT — TCP tunnel, no interception
server.on("connect", (req, clientSocket, head) => {
  const [host, portStr] = (req.url ?? "").split(":");
  const port = parseInt(portStr ?? "443", 10);

  if (!host || !port) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const serverSocket = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on("error", () => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });

  clientSocket.on("error", () => {
    serverSocket.destroy();
  });
});

server.on("error", (err) => {
  console.error(`[adblock-proxy] server error: ${err.message}`);
  process.exit(1);
});

async function start() {
  await loadFilters();

  // Periodic filter refresh
  if (REFRESH_HOURS > 0) {
    const ms = REFRESH_HOURS * 60 * 60 * 1000;
    setInterval(() => {
      loadFilters().catch((err) =>
        console.error(`[adblock-proxy] filter refresh error: ${err.message}`)
      );
    }, ms);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[adblock-proxy] listening on 0.0.0.0:${PORT}`);
  });
}

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

start().catch((err) => {
  console.error(`[adblock-proxy] startup error: ${err.message}`);
  process.exit(1);
});
