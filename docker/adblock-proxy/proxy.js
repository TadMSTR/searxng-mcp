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
 * GET /health (origin-form only): 200 when a rule set with at least one network
 * filter is loaded (status "partial" if some lists are missing from it), 503
 * otherwise. See README.md, "Health endpoint".
 *
 * Environment:
 *   PORT                  Listen port (default: 8118)
 *   ADBLOCK_FILTERS_URL   Comma-separated filter list URLs
 *                         (default: EasyList + EasyPrivacy)
 *   ADBLOCK_REFRESH_HOURS How often to refresh filters (default: 168)
 *   ADBLOCK_RETRY_MAX_MINUTES  Cap on the retry delay after a failed startup
 *                         load (default: 30)
 *   LOG_BLOCKED           Log blocked request URLs (default: false)
 */

const http = require("http");
const net = require("net");
const { URL } = require("url");
const { FiltersEngine, Request } = require("@ghostery/adblocker");
const { resolveSafeAddress } = require("./ssrf.js");

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
// Accepted range 1..1440 (one day). Anything else, missing, non-numeric, zero,
// negative or larger, falls back to the default. Both ends fail closed:
// below 1 would be a zero-delay retry loop, and above about 35,791 minutes the
// millisecond delay passes setTimeout's 2^31-1 limit, which Node replaces with
// 1 ms: the same tight loop.
const RETRY_MAX_DEFAULT = 30;
const RETRY_MAX_LIMIT = 1440;
function parseRetryMaxMinutes(raw) {
  if (raw === undefined || raw === "") return RETRY_MAX_DEFAULT;
  const n = /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  return n >= 1 && n <= RETRY_MAX_LIMIT ? n : RETRY_MAX_DEFAULT;
}
const RETRY_MAX_MINUTES = parseRetryMaxMinutes(process.env.ADBLOCK_RETRY_MAX_MINUTES);

// Per-list byte cap. EasyList is about 2.0 MB and EasyPrivacy about 1.5 MB
// (measured 2026-11-17), so 16 MiB is wide headroom for list growth while a
// misconfigured or hostile URL can't make the proxy buffer without limit. A
// list over the cap is a failed fetch, and reading stops at the cap.
const MAX_LIST_BYTES = 16 * 1024 * 1024;

// Upstream error text goes into single-line log entries: bounded, one line.
function oneLine(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

async function readCapped(res, limit) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`list exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The rule set in use. `engine` stays null until a load yields at least one
// network filter, and a refused load leaves the rule-set fields as they were:
// an empty engine filters nothing, so swapping one in would turn a working
// proxy into a pass-through that still reports success. `lastAttemptAt` and
// `lastAttemptOk` record every load, refused ones included, so /health can say
// a refresh is failing while the old rule set still serves.
const state = {
  engine: null,
  networkFilters: 0,
  cosmeticFilters: 0,
  loadedAt: null,
  listsFetched: 0,
  listsTotal: 0,
  lists: [],
  lastAttemptAt: null,
  lastAttemptOk: null,
};

/**
 * Fetch every list, parse them into one engine, and install it only if it has
 * network filters and, on a refresh, came from every list the rule set it
 * replaces came from. Returns true when the engine was replaced.
 *
 * `fetchImpl` and `urls` are parameters so the tests can load fixture lists
 * without a network.
 */
async function loadFilters({
  urls = FILTERS_URLS,
  fetchImpl = globalThis.fetch,
  maxListBytes = MAX_LIST_BYTES,
} = {}) {
  let combined = "";
  const fetchedUrls = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": "adblock-proxy/1.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`[adblock-proxy] filter fetch failed: ${url} status=${res.status}`);
        continue;
      }
      const text = await readCapped(res, maxListBytes);
      console.log(`[adblock-proxy] fetched ${url} (${Buffer.byteLength(text)} bytes)`);
      combined += text + "\n";
      fetchedUrls.push(url);
    } catch (err) {
      console.error(`[adblock-proxy] filter fetch error: ${url} ${oneLine(err.message)}`);
    }
  }

  const fetched = fetchedUrls.length;
  state.lastAttemptAt = new Date().toISOString();
  state.lastAttemptOk = false;

  // A refresh that lacks a list the rule set in use came from would drop that
  // list from filtering until the next refresh. Compared by URL, not by count:
  // an EasyPrivacy-only refresh is the same size as an EasyList-only rule set
  // and would swap one for the other. At startup a partial set is better than
  // none, so only a refresh is refused.
  const missing = state.lists.filter((u) => !fetchedUrls.includes(u));
  if (state.engine && fetched > 0 && missing.length > 0) {
    console.error(
      `[adblock-proxy] WARNING: refresh fetched ${fetched}/${urls.length} list(s), missing ` +
        `${missing.length} of the ${state.lists.length} the current rule set came from ` +
        `(${missing.join(", ")}) — keeping it ` +
        `(${state.networkFilters} network, ${state.cosmeticFilters} cosmetic, loaded ${state.loadedAt})`,
    );
    return false;
  }

  // FiltersEngine.parse("") returns a valid, empty engine rather than null, so
  // "every list failed" has to be detected from the count.
  const newEngine = FiltersEngine.parse(combined, { debug: false });
  const { networkFilters, cosmeticFilters } = newEngine.getFilters();

  if (networkFilters.length === 0) {
    if (state.engine) {
      console.error(
        `[adblock-proxy] WARNING: refresh produced 0 network filters ` +
          `(${fetched}/${urls.length} list(s) fetched) — keeping the previous rule set ` +
          `(${state.networkFilters} network, ${state.cosmeticFilters} cosmetic, loaded ${state.loadedAt})`,
      );
    } else {
      console.error(
        `[adblock-proxy] WARNING: no filters loaded (${fetched}/${urls.length} list(s) fetched) — ` +
          "all requests will pass through unfiltered and /health reports 503",
      );
    }
    return false;
  }

  state.engine = newEngine;
  state.networkFilters = networkFilters.length;
  state.cosmeticFilters = cosmeticFilters.length;
  state.loadedAt = state.lastAttemptAt;
  state.listsFetched = fetched;
  state.listsTotal = urls.length;
  state.lists = fetchedUrls;
  state.lastAttemptOk = true;
  console.log(
    `[adblock-proxy] loaded ${state.networkFilters} network and ${state.cosmeticFilters} cosmetic ` +
      `filters from ${fetched}/${urls.length} list(s)`,
  );
  return true;
}

/**
 * Delay before startup retry `attempt` (1-based): 1, 2, 4, 8, 16 minutes, then
 * `maxMinutes` (30 by default) from then on.
 */
function retryDelayMinutes(attempt, maxMinutes = RETRY_MAX_MINUTES) {
  return Math.min(2 ** (attempt - 1), maxMinutes);
}

/**
 * After a startup load that installed no engine, retry with backoff until one
 * succeeds. Without this the proxy passed everything unfiltered until the next
 * scheduled refresh, a week away by default.
 *
 * Only the startup case retries. A failed scheduled refresh keeps the previous
 * engine, which still filters, so it waits for the next interval as before.
 * The periodic refresh keeps its own schedule, counted from startup.
 *
 * Returns `{ cancel }` so tests (and shutdown) can stop a pending retry.
 */
function retryStartupLoad({
  load = () => loadFilters(),
  maxMinutes = RETRY_MAX_MINUTES,
} = {}) {
  let attempt = 0;
  let timer = null;
  let cancelled = false;

  const schedule = () => {
    attempt += 1;
    const minutes = retryDelayMinutes(attempt, maxMinutes);
    console.error(
      `[adblock-proxy] no filters loaded — startup retry ${attempt} in ${minutes} min`,
    );
    timer = setTimeout(run, minutes * 60 * 1000);
  };

  const run = async () => {
    timer = null;
    try {
      await load();
    } catch (err) {
      console.error(`[adblock-proxy] startup retry ${attempt} error: ${oneLine(err.message)}`);
    }
    if (cancelled) return;
    if (state.engine) {
      console.log(
        `[adblock-proxy] startup retry ${attempt} loaded filters — retries stopped`,
      );
      return;
    }
    schedule();
  };

  if (!state.engine) schedule();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function isBlocked(url, sourceUrl = "") {
  if (!state.engine) return false;
  try {
    const req = Request.fromRawDetails({ url, sourceUrl, type: "other" });
    return state.engine.match(req).match;
  } catch {
    return false;
  }
}

// A rule set older than two refresh intervals means refreshes have been
// failing (or refused) for at least two attempts in a row. It still filters,
// but /health turns 503 so the HEALTHCHECK and anything watching it notice.
//
// A rule set missing some configured lists reports "partial", never "ok". It
// stays 200: it filters, and a one-list outage at startup should not mark the
// container unhealthy for a whole refresh interval. Only the status says so,
// and a partial set that keeps reinstalling (which keeps loaded_at fresh, so
// it never goes stale) is still reported.
function healthBody({ now = Date.now(), refreshHours = REFRESH_HOURS } = {}) {
  const loaded = state.engine !== null && state.networkFilters > 0;
  const stale =
    loaded &&
    refreshHours > 0 &&
    now - Date.parse(state.loadedAt) > 2 * refreshHours * 60 * 60 * 1000;
  const partial = loaded && state.listsFetched < state.listsTotal;
  const status = !loaded ? "no_filters" : stale ? "stale" : partial ? "partial" : "ok";
  return {
    code: status === "ok" || status === "partial" ? 200 : 503,
    body: {
      status,
      network_filters: state.networkFilters,
      cosmetic_filters: state.cosmeticFilters,
      loaded_at: state.loadedAt,
      lists_fetched: state.listsFetched,
      lists_total: state.listsTotal,
      last_attempt_at: state.lastAttemptAt,
      last_attempt_ok: state.lastAttemptOk,
    },
  };
}

function handleRequest(req, res) {
  // Health check. A forward proxy's real requests are absolute-form
  // (`GET http://host/path`) or CONNECT, so an ORIGIN-form request for exactly
  // `/health` cannot be a proxied request and is answered here. `http://x/health`
  // is absolute-form, does not match, and takes the proxy path below with its
  // SSRF guard. Every other origin-form path is unchanged (400 from the URL
  // parse): this is a health route, not a local web server.
  if (req.method === "GET" && req.url === "/health") {
    const { code, body } = healthBody();
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    res.end(payload);
    return;
  }

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

  // SSRF: resolve and validate before connecting. This path previously had no
  // address check of any kind — only the CONNECT handler did — so a plain-HTTP
  // target resolving to an internal address was proxied straight through.
  resolveSafeAddress(parsed.hostname).then((address) => {
    if (!address) {
      if (LOG_BLOCKED) {
        console.log(`[adblock-proxy] refused non-public target ${parsed.hostname}`);
      }
      res.writeHead(403);
      res.end();
      return;
    }

    const options = {
      // Connect to the validated ADDRESS, not the hostname: re-resolving by
      // name here would reopen the DNS-rebinding window the check just closed.
      // The Host header still carries the original name, so virtual hosts and
      // redirects behave unchanged.
      hostname: address,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers, host: parsed.host },
    };

    const proxy = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });

    req.pipe(proxy, { end: true });
  });
}

// HTTPS CONNECT — TCP tunnel, no interception
//
// SECURITY[control]: blocks internal-address tunneling via CONNECT.
// Audit: 2026-06-05/searxng-mcp-transport-2026-06 (original string blocklist),
// 2026-09-02/searxng-mcp-solver-tier-2026-09 (MEDIUM, SSRF-10 — the string
// blocklist tested the literal CONNECT hostname and then called
// net.connect(port, host), which re-resolved with no rebinding protection).
// Now resolved and validated before connecting, and pinned to the validated
// address so there is no window to race.
function handleConnect(req, clientSocket, head) {
  const [host, portStr] = (req.url ?? "").split(":");
  const port = parseInt(portStr ?? "443", 10);

  if (!host || !port) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  resolveSafeAddress(host).then((address) => {
    if (!address) {
      if (LOG_BLOCKED) {
        console.log(`[adblock-proxy] refused non-public CONNECT ${host}`);
      }
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    // Connect to the validated address, not the name. TLS is end-to-end through
    // this tunnel — the client sends its own SNI and validates the origin
    // certificate itself — so pinning the address here changes nothing the
    // client relies on.
    const serverSocket = net.connect(port, address, () => {
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
}

function createServer() {
  const server = http.createServer(handleRequest);
  server.on("connect", handleConnect);
  return server;
}

async function start() {
  const server = createServer();

  server.on("error", (err) => {
    console.error(`[adblock-proxy] server error: ${err.message}`);
    process.exit(1);
  });

  const rawRetryMax = process.env.ADBLOCK_RETRY_MAX_MINUTES;
  if (rawRetryMax !== undefined && rawRetryMax !== "" && String(RETRY_MAX_MINUTES) !== rawRetryMax.trim()) {
    console.error(
      `[adblock-proxy] WARNING: ADBLOCK_RETRY_MAX_MINUTES must be a whole number from 1 to ${RETRY_MAX_LIMIT}; using ${RETRY_MAX_MINUTES}`,
    );
  }

  await loadFilters();
  const startupRetry = retryStartupLoad();

  // Periodic filter refresh
  if (REFRESH_HOURS > 0) {
    const ms = REFRESH_HOURS * 60 * 60 * 1000;
    setInterval(() => {
      loadFilters().catch((err) =>
        console.error(`[adblock-proxy] filter refresh error: ${oneLine(err.message)}`)
      );
    }, ms);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[adblock-proxy] listening on 0.0.0.0:${PORT}`);
  });

  process.on("SIGTERM", () => {
    startupRetry.cancel();
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    startupRetry.cancel();
    server.close(() => process.exit(0));
  });
}

// Started only when run directly (`node proxy.js`), so the tests can require
// this module without opening a port or fetching lists.
if (require.main === module) {
  start().catch((err) => {
    console.error(`[adblock-proxy] startup error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  loadFilters,
  isBlocked,
  healthBody,
  parseRetryMaxMinutes,
  retryDelayMinutes,
  retryStartupLoad,
  state,
};
