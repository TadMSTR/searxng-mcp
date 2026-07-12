import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cache.js", () => ({
  getValkey: vi.fn(),
  cacheGet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { getValkey } from "../../src/cache.js";
import { runRestore } from "../../src/cli/restore-domain-db.js";
import type { DomainRecord } from "../../src/domain-db.js";
import type { RestoreClient } from "../../src/domain-snapshot.js";
import { writeSnapshot } from "../../src/domain-snapshot.js";

const getValkeyMock = vi.mocked(getValkey);
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
  dir = await mkdtemp(join(tmpdir(), "restore-"));
  getValkeyMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runRestore", () => {
  it("returns no-snapshot when the dir is empty", async () => {
    const r = await runRestore(dir);
    expect(r.status).toBe("no-snapshot");
    expect(getValkeyMock).not.toHaveBeenCalled();
  });

  it("returns no-valkey when Valkey is unavailable", async () => {
    await writeSnapshot(dir, [mkRecord("a.com", "2026-06-01T00:00:00Z")]);
    getValkeyMock.mockResolvedValue(null);
    const r = await runRestore(dir);
    expect(r.status).toBe("no-valkey");
    expect(r.restored).toBe(0);
    expect(r.total).toBe(1);
  });

  it("re-seeds missing keys from the latest snapshot", async () => {
    await writeSnapshot(dir, [
      mkRecord("a.com", "2026-06-01T00:00:00Z"),
      mkRecord("b.com", "2026-06-01T00:00:00Z"),
    ]);
    const client = memClient();
    getValkeyMock.mockResolvedValue(
      client as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>,
    );

    const r = await runRestore(dir);
    expect(r.status).toBe("ok");
    expect(r).toMatchObject({ total: 2, restored: 2, skipped: 0 });
    expect(client.store.has("domain:a.com")).toBe(true);
    expect(client.store.has("domain:b.com")).toBe(true);
    expect(r.snapshotCreated).toBeTruthy();
  });

  it("does not clobber a fresher live record", async () => {
    await writeSnapshot(dir, [mkRecord("a.com", "2026-06-01T00:00:00Z")]);
    const live = mkRecord("a.com", "2026-06-20T00:00:00Z");
    const client = memClient({ "domain:a.com": JSON.stringify(live) });
    getValkeyMock.mockResolvedValue(
      client as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>,
    );

    const r = await runRestore(dir);
    expect(r).toMatchObject({ restored: 0, skipped: 1 });
    expect(client.store.get("domain:a.com")).toBe(JSON.stringify(live));
  });
});
