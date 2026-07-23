import { createHash } from "node:crypto";
import { Redis as Valkey } from "iovalkey";
import {
  CACHE_COMMAND_TIMEOUT_MS,
  CACHE_CONNECT_TIMEOUT_MS,
  CACHE_MAX_RETRIES_PER_REQUEST,
  CACHE_URL,
} from "./config.js";
import { events } from "./events.js";
import { logThrottled } from "./log.js";
import { incCounter } from "./observability.js";

function namespaceOf(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : key;
}

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
      `cache connect failed (${CACHE_URL}) — serving live, cache disabled: ${err instanceof Error ? err.message : String(err)}`,
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

// Atomic read-modify-write using WATCH/MULTI/EXEC (optimistic locking).
// `mutateFn` receives the current raw value (or null) and returns the new value.
// Retries up to `maxRetries` times on concurrent-modification conflicts.
// Best-effort: returns without throwing on any error or Valkey unavailability.
export async function cacheAtomicUpdate(
  key: string,
  ttl: number,
  mutateFn: (raw: string | null) => string,
  maxRetries = 3,
): Promise<void> {
  const client = await getValkey();
  if (!client) return;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await client.watch(key);
      const raw = await client.get(key);
      const updated = mutateFn(raw);
      const pipeline = client.multi();
      pipeline.set(key, updated, "EX", ttl);
      const results = await pipeline.exec();
      if (results !== null) return; // transaction committed
      // results === null: key modified between WATCH and EXEC — retry
    } catch {
      // SECURITY[accepted]: exits retry on first exception (transient errors consume full budget).
      // Intentional best-effort design — domain-db writes are fire-and-forget. Audit: 2026-06-05/searxng-mcp-polish-2026-06.
      return; // best-effort — never throw
    }
  }
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
