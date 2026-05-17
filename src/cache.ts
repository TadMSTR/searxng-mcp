import { createHash } from "node:crypto";
import { Redis as Valkey } from "iovalkey";
import { VALKEY_URL } from "./config.js";
import { events } from "./events.js";
import { incCounter } from "./observability.js";

function namespaceOf(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : key;
}

let valkey: Valkey | null = null;

export async function getValkey(): Promise<Valkey | null> {
  if (valkey !== null) return valkey;
  try {
    const client = new Valkey(VALKEY_URL, {
      lazyConnect: true,
      enableReadyCheck: false,
    });
    client.on("error", () => {
      client.disconnect();
      valkey = null;
    });
    await client.connect();
    valkey = client;
    return valkey;
  } catch {
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
  } catch {
    incCounter("cache", { namespace, outcome: "error" });
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
