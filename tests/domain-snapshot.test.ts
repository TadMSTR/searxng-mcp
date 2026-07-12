import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainRecord } from "../src/domain-db.js";
import {
  applyRestore,
  listSnapshots,
  loadLatestSnapshot,
  pruneSnapshots,
  type RestoreClient,
  snapshotFilename,
  writeSnapshot,
} from "../src/domain-snapshot.js";

const NOW = Date.now();

function emptyStat() {
  return { attempts: 0, ok: 0, fail: 0, window_start_ms: NOW };
}

function mkRecord(domain: string, lastFetch: string): DomainRecord {
  return {
    schema_version: 4,
    domain,
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: lastFetch,
    capabilities: {},
    tier_stats_30d: {
      tier1: emptyStat(),
      tier2: emptyStat(),
      tier3: emptyStat(),
      tier4: emptyStat(),
      github: emptyStat(),
    },
  };
}

// In-memory Valkey stand-in for the restore path.
function memClient(initial: Record<string, string> = {}): RestoreClient & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "domain-snap-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("snapshotFilename", () => {
  it("is filesystem-safe (no colons) and sortable", () => {
    const name = snapshotFilename(new Date("2026-07-12T17:30:00.000Z"));
    expect(name).toBe("domain-db-2026-07-12T17-30-00.000Z.json");
    expect(name).not.toContain(":");
  });
});

describe("writeSnapshot + loadLatestSnapshot", () => {
  it("round-trips records through a written snapshot", async () => {
    const records = [mkRecord("a.com", "2026-06-01T00:00:00Z")];
    const { path, count } = await writeSnapshot(dir, records);
    expect(count).toBe(1);
    expect(path).toContain(dir);

    const loaded = await loadLatestSnapshot(dir);
    expect(loaded?.count).toBe(1);
    expect(loaded?.schema_version).toBe(4);
    expect(loaded?.records[0].domain).toBe("a.com");

    // FW-01: atomic write leaves no leftover .tmp file behind.
    const entries = await readdir(dir);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("creates the snapshot dir if it does not exist", async () => {
    const nested = join(dir, "nested", "snaps");
    await writeSnapshot(nested, [mkRecord("a.com", "2026-06-01T00:00:00Z")]);
    const loaded = await loadLatestSnapshot(nested);
    expect(loaded?.count).toBe(1);
  });

  it("loadLatestSnapshot returns null for an empty/absent dir", async () => {
    expect(await loadLatestSnapshot(join(dir, "does-not-exist"))).toBeNull();
    expect(await loadLatestSnapshot(dir)).toBeNull();
  });

  it("loadLatestSnapshot picks the newest by filename", async () => {
    await writeSnapshot(
      dir,
      [mkRecord("old.com", "2026-05-01T00:00:00Z")],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    await writeSnapshot(
      dir,
      [mkRecord("new.com", "2026-06-01T00:00:00Z")],
      new Date("2026-07-10T00:00:00.000Z"),
    );
    const loaded = await loadLatestSnapshot(dir);
    expect(loaded?.records[0].domain).toBe("new.com");
  });

  it("loadLatestSnapshot returns null on a malformed snapshot", async () => {
    await writeFile(
      join(dir, "domain-db-2026-07-12T00-00-00.000Z.json"),
      "{not json",
      "utf-8",
    );
    expect(await loadLatestSnapshot(dir)).toBeNull();
  });
});

describe("listSnapshots", () => {
  it("only lists matching snapshot files, sorted ascending", async () => {
    await writeFile(
      join(dir, "domain-db-2026-07-02T00-00-00.000Z.json"),
      "{}",
      "utf-8",
    );
    await writeFile(
      join(dir, "domain-db-2026-07-01T00-00-00.000Z.json"),
      "{}",
      "utf-8",
    );
    await writeFile(join(dir, "unrelated.json"), "{}", "utf-8");
    await writeFile(join(dir, "notes.txt"), "x", "utf-8");
    // A leftover atomic-write temp file must be ignored.
    await writeFile(
      join(dir, "domain-db-2026-07-03T00-00-00.000Z.json.tmp"),
      "{}",
      "utf-8",
    );
    const names = await listSnapshots(dir);
    expect(names).toEqual([
      "domain-db-2026-07-01T00-00-00.000Z.json",
      "domain-db-2026-07-02T00-00-00.000Z.json",
    ]);
  });
});

describe("pruneSnapshots", () => {
  it("keeps the newest `retention` snapshots and deletes older ones", async () => {
    for (const day of ["01", "02", "03", "04"]) {
      await writeFile(
        join(dir, `domain-db-2026-07-${day}T00-00-00.000Z.json`),
        "{}",
        "utf-8",
      );
    }
    const deleted = await pruneSnapshots(dir, 2);
    expect(deleted).toEqual([
      "domain-db-2026-07-01T00-00-00.000Z.json",
      "domain-db-2026-07-02T00-00-00.000Z.json",
    ]);
    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual([
      "domain-db-2026-07-03T00-00-00.000Z.json",
      "domain-db-2026-07-04T00-00-00.000Z.json",
    ]);
  });

  it("deletes nothing when at or under retention", async () => {
    await writeFile(
      join(dir, "domain-db-2026-07-01T00-00-00.000Z.json"),
      "{}",
      "utf-8",
    );
    expect(await pruneSnapshots(dir, 14)).toEqual([]);
  });

  it("never prunes everything (retention < 1 treated as 1)", async () => {
    await writeFile(
      join(dir, "domain-db-2026-07-01T00-00-00.000Z.json"),
      "{}",
      "utf-8",
    );
    await writeFile(
      join(dir, "domain-db-2026-07-02T00-00-00.000Z.json"),
      "{}",
      "utf-8",
    );
    const deleted = await pruneSnapshots(dir, 0);
    expect(deleted).toEqual(["domain-db-2026-07-01T00-00-00.000Z.json"]);
    expect(await readdir(dir)).toHaveLength(1);
  });
});

describe("applyRestore", () => {
  it("restores a key that is missing from live Valkey", async () => {
    const client = memClient();
    const rec = mkRecord("a.com", "2026-06-01T00:00:00Z");
    const result = await applyRestore(client, [rec]);
    expect(result).toEqual({ total: 1, restored: 1, skipped: 0 });
    expect(client.store.get("domain:a.com")).toBe(JSON.stringify(rec));
  });

  it("skips a key whose live record is fresher-or-equal (never clobbers)", async () => {
    const live = mkRecord("a.com", "2026-06-10T00:00:00Z");
    const client = memClient({ "domain:a.com": JSON.stringify(live) });
    const snapshotRec = mkRecord("a.com", "2026-06-01T00:00:00Z"); // older
    const result = await applyRestore(client, [snapshotRec]);
    expect(result).toEqual({ total: 1, restored: 0, skipped: 1 });
    // Live record untouched.
    expect(client.store.get("domain:a.com")).toBe(JSON.stringify(live));
  });

  it("restores when the snapshot is strictly fresher than a staler live record", async () => {
    const live = mkRecord("a.com", "2026-05-01T00:00:00Z");
    const client = memClient({ "domain:a.com": JSON.stringify(live) });
    const snapshotRec = mkRecord("a.com", "2026-06-01T00:00:00Z"); // newer
    const result = await applyRestore(client, [snapshotRec]);
    expect(result).toEqual({ total: 1, restored: 1, skipped: 0 });
    expect(client.store.get("domain:a.com")).toBe(JSON.stringify(snapshotRec));
  });

  it("skips records on a different schema version", async () => {
    const client = memClient();
    const stale = {
      ...mkRecord("a.com", "2026-06-01T00:00:00Z"),
      schema_version: 3,
    };
    const result = await applyRestore(client, [stale as DomainRecord]);
    expect(result).toEqual({ total: 1, restored: 0, skipped: 1 });
    expect(client.store.size).toBe(0);
  });

  it("counts a per-key set failure as skipped, not fatal", async () => {
    const client: RestoreClient = {
      get: async () => null,
      set: async () => {
        throw new Error("write failed");
      },
    };
    const result = await applyRestore(client, [
      mkRecord("a.com", "2026-06-01T00:00:00Z"),
      mkRecord("b.com", "2026-06-01T00:00:00Z"),
    ]);
    expect(result).toEqual({ total: 2, restored: 0, skipped: 2 });
  });
});
