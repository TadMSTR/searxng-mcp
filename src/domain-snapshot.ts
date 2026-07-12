// Durable JSON snapshots of the domain capability database. The domain-db lives
// only in Valkey under a 90-day TTL and 30-day rolling windows, so a cache flush
// or TTL expiry erases capability learning that is expensive to re-acquire. The
// maintenance job writes a dated snapshot of all `domain:*` records here; the
// restore CLI re-seeds only missing (or strictly-staler) live keys from the
// newest snapshot, never clobbering a fresher live record.
//
// Snapshots are our own dated files (no caller-supplied names), and every read
// path validates filenames against SNAPSHOT_FILE_RE and resolves within the
// snapshot dir — no path traversal via the on-disk contents.

import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DOMAIN_RECORD_TTL_SECONDS,
  type DomainRecord,
  domainKey,
  SCHEMA_VERSION,
} from "./domain-db.js";

const SNAPSHOT_PREFIX = "domain-db-";
const SNAPSHOT_SUFFIX = ".json";
// Matches only snapshots this module writes: the prefix, an ISO-ish timestamp
// (digits, T, Z, dashes, dots), then .json. Anything else in the dir is ignored.
const SNAPSHOT_FILE_RE = /^domain-db-[0-9TZ.-]+\.json$/;

export interface DomainSnapshot {
  created: string;
  schema_version: number;
  count: number;
  records: DomainRecord[];
}

// Minimal Valkey surface used by the restore path — kept narrow so tests can
// pass a fake without pulling in iovalkey.
export interface RestoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
}

export interface RestoreResult {
  total: number;
  restored: number;
  skipped: number;
}

/** Filesystem-safe, lexicographically-sortable snapshot filename for `now`. */
export function snapshotFilename(now: Date): string {
  const stamp = now.toISOString().replace(/:/g, "-");
  return `${SNAPSHOT_PREFIX}${stamp}${SNAPSHOT_SUFFIX}`;
}

/**
 * Write a snapshot of `records` to `dir` (created if absent). Returns the full
 * path and record count.
 */
export async function writeSnapshot(
  dir: string,
  records: DomainRecord[],
  now: Date = new Date(),
): Promise<{ path: string; count: number }> {
  await mkdir(dir, { recursive: true });
  const snapshot: DomainSnapshot = {
    created: now.toISOString(),
    schema_version: SCHEMA_VERSION,
    count: records.length,
    records,
  };
  const path = join(dir, snapshotFilename(now));
  // FW-01: write to a temp file then rename so a crash mid-write can never
  // leave a truncated newest snapshot (which loadLatestSnapshot would reject,
  // breaking restore). rename within the same dir is atomic. `.tmp` is not a
  // valid snapshot name (SNAPSHOT_FILE_RE), so a leftover temp is ignored.
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(snapshot), "utf-8");
  await rename(tmpPath, path);
  return { path, count: records.length };
}

/** List snapshot filenames in `dir`, oldest first. Missing dir → empty. */
export async function listSnapshots(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => SNAPSHOT_FILE_RE.test(f)).sort();
}

/**
 * Delete snapshots beyond the newest `retention` files. Returns the deleted
 * filenames. `retention < 1` is treated as 1 (never prune everything).
 */
export async function pruneSnapshots(
  dir: string,
  retention: number,
): Promise<string[]> {
  const keep = Math.max(1, retention);
  const all = await listSnapshots(dir);
  if (all.length <= keep) return [];
  const toDelete = all.slice(0, all.length - keep);
  for (const name of toDelete) {
    // Defence-in-depth: only ever unlink names we produced, inside `dir`.
    if (!SNAPSHOT_FILE_RE.test(name)) continue;
    await unlink(join(dir, basename(name)));
  }
  return toDelete;
}

/** Load and parse the newest snapshot in `dir`, or null if none/invalid. */
export async function loadLatestSnapshot(
  dir: string,
): Promise<DomainSnapshot | null> {
  const all = await listSnapshots(dir);
  const latest = all[all.length - 1];
  if (!latest) return null;
  try {
    const raw = await readFile(join(dir, basename(latest)), "utf-8");
    const parsed = JSON.parse(raw) as DomainSnapshot;
    if (!Array.isArray(parsed.records)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Re-seed `records` into Valkey, restoring only keys that are missing or whose
 * live record is strictly staler than the snapshot (older last_fetch). Never
 * overwrites a fresher-or-equal live record. Records on a different schema than
 * the current one are skipped. Best-effort per key — a single failure is
 * counted as skipped, not fatal.
 */
export async function applyRestore(
  client: RestoreClient,
  records: DomainRecord[],
): Promise<RestoreResult> {
  let restored = 0;
  let skipped = 0;
  for (const record of records) {
    if (record.schema_version !== SCHEMA_VERSION || !record.domain) {
      skipped += 1;
      continue;
    }
    const key = domainKey(record.domain);
    try {
      const liveRaw = await client.get(key);
      if (liveRaw) {
        let live: DomainRecord | null = null;
        try {
          live = JSON.parse(liveRaw) as DomainRecord;
        } catch {
          live = null;
        }
        // Live record present and fresher-or-equal → never clobber it.
        if (live && live.last_fetch >= record.last_fetch) {
          skipped += 1;
          continue;
        }
      }
      await client.set(
        key,
        JSON.stringify(record),
        "EX",
        DOMAIN_RECORD_TTL_SECONDS,
      );
      restored += 1;
    } catch {
      skipped += 1;
    }
  }
  return { total: records.length, restored, skipped };
}
