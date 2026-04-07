import { createHash } from "node:crypto";
import { Redis as Valkey } from "iovalkey";
import { VALKEY_URL } from "./config.js";

let valkey: Valkey | null = null;

export async function getValkey(): Promise<Valkey | null> {
  if (valkey !== null) return valkey;
  try {
    const client = new Valkey(VALKEY_URL, { lazyConnect: true, enableReadyCheck: false });
    client.on("error", () => {
      // Silently disconnect on error — caching is best-effort
      valkey = null;
    });
    await client.connect();
    valkey = client;
    return valkey;
  } catch {
    return null;
  }
}

export function searchCacheKey(query: string, category: string, timeRange?: string): string {
  const raw = `${query}|${category}|${timeRange ?? ""}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

export function fetchCacheKey(url: string): string {
  return `fetch:${createHash("sha256").update(url).digest("hex")}`;
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const client = await getValkey();
    if (!client) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttl: number): Promise<void> {
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
    const keys = await client.keys(pattern);
    if (keys.length === 0) return 0;
    await client.del(keys);
    return keys.length;
  } catch {
    return 0;
  }
}
