import { createHash } from "node:crypto";
import { Redis as Valkey } from "iovalkey";
import {
  CACHE_COMMAND_TIMEOUT_MS,
  CACHE_CONNECT_TIMEOUT_MS,
  CACHE_MAX_RETRIES_PER_REQUEST,
  CACHE_URL,
} from "./config.js";
import { events } from "./events.js";
import { logThrottled, redactUrlCredentials } from "./log.js";
import { incCounter } from "./observability.js";

function namespaceOf(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : key;
}

// Compare-and-set, evaluated server-side. `cacheAtomicUpdate` reads a value,
// mutates it in JS, then commits through this script: the SET only lands if the
// key still holds exactly the value that was read.
//
// This replaces WATCH/MULTI/EXEC, which could not work here. `getValkey()`
// returns a module-level singleton connection and WATCH is *connection*-scoped,
// not call-scoped — so concurrent callers interleaved as WATCH,WATCH,GET,GET,
// EXEC,EXEC. Both reads saw the same base document, and the first EXEC cleared
// the connection's entire watch set, letting the second commit unconditionally
// over stale data. `results !== null` then read as a successful commit, so the
// retry loop never fired and the losing write was discarded silently.
//
// A Lua script carries no connection state: the comparison and the write happen
// inside one atomic server-side execution, so a stale commit is impossible no
// matter how many callers — or processes — share the connection.
//
// ARGV[1] '1' when the caller read an existing value, '0' when it read a miss.
//         The miss case must be distinguished explicitly: a non-existent key
//         reads as Lua `false`, which compares unequal to every string
//         including the empty one, so a create would otherwise never commit.
// ARGV[2] the value the caller read (ignored when ARGV[1] is '0')
// ARGV[3] the value to write
// ARGV[4] TTL in seconds
const CAS_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current == false or current ~= ARGV[2] then return 0 end
else
  if current ~= false then return 0 end
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

// iovalkey attaches `defineCommand` scripts to the client instance; the added
// method is not inferred, so declare the shape we call.
type ValkeyWithCas = Valkey & {
  casSet(
    key: string,
    hasExpected: "0" | "1",
    expected: string,
    value: string,
    ttl: string,
  ): Promise<number>;
};

let valkey: Valkey | null = null;

export async function getValkey(): Promise<Valkey | null> {
  if (valkey !== null) return valkey;
  try {
    const client = new Valkey(CACHE_URL, {
      lazyConnect: true,
      enableReadyCheck: false,
      // Resilience: a stalled backend now rejects commands instead of hanging
      // cacheGet() (the first await in every search) forever. Fail-soft catches
      // below degrade the rejection to a cache miss. See config.ts for defaults.
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      connectTimeout: CACHE_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: CACHE_MAX_RETRIES_PER_REQUEST,
    });
    // Registered per client (not once globally) because the error handler below
    // drops `valkey` on failure and the next getValkey() builds a fresh client.
    // defineCommand runs EVALSHA and transparently falls back to EVAL on
    // NOSCRIPT, so a backend restart that flushes the script cache self-heals.
    client.defineCommand("casSet", {
      numberOfKeys: 1,
      lua: CAS_SET_SCRIPT,
    });
    client.on("error", (err: unknown) => {
      logThrottled(
        "cache:client-error",
        `cache client error — serving live until it recovers: ${err instanceof Error ? err.message : String(err)}`,
      );
      client.disconnect();
      valkey = null;
    });
    await client.connect();
    valkey = client;
    return valkey;
  } catch (err) {
    logThrottled(
      "cache:connect-failed",
      `cache connect failed (${redactUrlCredentials(CACHE_URL)}) — serving live, cache disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function searchCacheKey(
  query: string,
  category: string,
  timeRange?: string,
): string {
  const raw = `${query}|${category}|${timeRange ?? ""}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

export function fetchCacheKey(url: string): string {
  return `fetch:${createHash("sha256").update(url).digest("hex")}`;
}

export async function cacheGet(key: string): Promise<string | null> {
  const namespace = namespaceOf(key);
  try {
    const client = await getValkey();
    if (!client) {
      incCounter("cache", { namespace, outcome: "unavailable" });
      logThrottled(
        `cache:unavailable:${namespace}`,
        `cache unavailable (namespace=${namespace}) — serving live (cache miss)`,
      );
      return null;
    }
    const value = await client.get(key);
    if (value !== null) {
      incCounter("cache", { namespace, outcome: "hit" });
      events.cacheHit({ key_type: "get", namespace });
    } else {
      incCounter("cache", { namespace, outcome: "miss" });
      events.cacheMiss({ key_type: "get", namespace });
    }
    return value;
  } catch (err) {
    incCounter("cache", { namespace, outcome: "error" });
    logThrottled(
      `cache:error:${namespace}`,
      `cache get failed (namespace=${namespace}) — serving live (cache miss): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttl: number,
): Promise<void> {
  try {
    const client = await getValkey();
    if (!client) return;
    await client.set(key, value, "EX", ttl);
  } catch {
    // Best-effort — never throw
  }
}

// Serializes same-key updates within this process. Two independent mechanisms
// are needed and they cover different halves of the problem:
//
//   - The Lua CAS below makes a *cross-process* stale commit impossible, but it
//     detects conflicts rather than preventing them, so it burns a retry per
//     collision. `fetchPage` alone issues three fire-and-forget writes against
//     the same `domain:<host>` key, and a burst of concurrent fetches for one
//     domain would exhaust the retry budget and drop writes again — a quieter
//     version of the bug being fixed.
//   - This queue removes in-process contention outright, so the CAS is left
//     arbitrating only the genuinely concurrent case: another process, or a
//     second connection.
//
// An earlier revision had a per-hostname queue in domain-db.ts and replaced it
// with WATCH/MULTI/EXEC on the reasoning that the queue was single-process. The
// reasoning was right and the conclusion was wrong: the two are complementary,
// not alternatives.
const inflightUpdates = new Map<string, Promise<void>>();

// Atomic read-modify-write via a server-side compare-and-set (see
// CAS_SET_SCRIPT). `mutateFn` receives the current raw value (or null) and
// returns the new value. Retries up to `maxRetries` times when another writer
// commits between the read and the CAS.
// Best-effort: returns without throwing on any error or Valkey unavailability.
export function cacheAtomicUpdate(
  key: string,
  ttl: number,
  mutateFn: (raw: string | null) => string,
  maxRetries = 3,
): Promise<void> {
  const previous = inflightUpdates.get(key) ?? Promise.resolve();
  // casUpdate is fail-soft and never rejects, so the chain cannot be poisoned
  // by one bad update and no link needs its own catch.
  const current = previous.then(() =>
    casUpdate(key, ttl, mutateFn, maxRetries),
  );
  inflightUpdates.set(key, current);
  void current.finally(() => {
    // Only the tail clears the entry; an earlier link finishing must not drop a
    // successor's promise, or the map would stop serializing that key.
    if (inflightUpdates.get(key) === current) inflightUpdates.delete(key);
  });
  return current;
}

async function casUpdate(
  key: string,
  ttl: number,
  mutateFn: (raw: string | null) => string,
  maxRetries: number,
): Promise<void> {
  const client = await getValkey();
  if (!client) return;
  const namespace = namespaceOf(key);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await client.get(key);
      const updated = mutateFn(raw);
      const committed = await (client as ValkeyWithCas).casSet(
        key,
        raw === null ? "0" : "1",
        raw ?? "",
        updated,
        String(ttl),
      );
      if (committed === 1) return;
      // committed === 0: another writer changed the key between our GET and the
      // CAS. Re-read and re-apply the mutation against the current value.
      incCounter("cache", { namespace, outcome: "cas_retry" });
    } catch {
      // SECURITY[accepted]: exits retry on first exception (transient errors consume full budget).
      // Intentional best-effort design — domain-db writes are fire-and-forget. Audit: 2026-06-05/searxng-mcp-polish-2026-06.
      // Unchanged by the CAS rewrite: this governs exceptions, not conflicts,
      // and conflict retries are now a separate (and reachable) path above.
      return; // best-effort — never throw
    }
  }
  // Retry budget exhausted — this update is dropped. Previously unreachable and
  // therefore silent; surfaced now so sustained contention is visible rather
  // than showing up months later as a starved field.
  incCounter("cache", { namespace, outcome: "cas_exhausted" });
  logThrottled(
    `cache:cas-exhausted:${namespace}`,
    `cache atomic update gave up after ${maxRetries} attempts (namespace=${namespace}) — update dropped`,
  );
}

export async function cacheClear(pattern: string): Promise<number> {
  try {
    const client = await getValkey();
    if (!client) return 0;
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return 0;
    await client.del(keys);
    return keys.length;
  } catch {
    return 0;
  }
}

// Bounded liveness probe for the /health endpoint. Uses the same short command
// timeout as every other cache op (via getValkey), so a stalled backend fails
// fast and the health check itself can never hang.
export async function cachePing(): Promise<boolean> {
  try {
    const client = await getValkey();
    if (!client) return false;
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}
