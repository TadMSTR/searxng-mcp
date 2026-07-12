#!/usr/bin/env node
// Operator CLI: re-seed the domain-db from the newest durable snapshot after a
// Valkey flush or TTL expiry. Restores only keys that are missing or whose live
// record is strictly staler than the snapshot — never clobbers a fresher-or-
// equal live record (see applyRestore). Safe to run against a live, partially-
// populated Valkey.
//
// Usage: pnpm restore-domain-db   (reads DOMAIN_DB_SNAPSHOT_DIR)

import { getValkey } from "../cache.js";
import { DOMAIN_DB_SNAPSHOT_DIR } from "../config.js";
import {
  applyRestore,
  loadLatestSnapshot,
  type RestoreClient,
  type RestoreResult,
} from "../domain-snapshot.js";

export interface RestoreRunResult extends RestoreResult {
  snapshotCreated: string | null;
  status: "ok" | "no-snapshot" | "no-valkey";
}

export async function runRestore(
  snapshotDir: string = DOMAIN_DB_SNAPSHOT_DIR,
): Promise<RestoreRunResult> {
  const snapshot = await loadLatestSnapshot(snapshotDir);
  if (!snapshot) {
    return {
      total: 0,
      restored: 0,
      skipped: 0,
      snapshotCreated: null,
      status: "no-snapshot",
    };
  }

  const client = (await getValkey()) as RestoreClient | null;
  if (!client) {
    return {
      total: snapshot.records.length,
      restored: 0,
      skipped: snapshot.records.length,
      snapshotCreated: snapshot.created,
      status: "no-valkey",
    };
  }

  const result = await applyRestore(client, snapshot.records);
  return { ...result, snapshotCreated: snapshot.created, status: "ok" };
}

export async function main(): Promise<number> {
  const r = await runRestore();
  if (r.status === "no-snapshot") {
    console.error(
      `[restore-domain-db] no snapshot found in ${DOMAIN_DB_SNAPSHOT_DIR}`,
    );
    return 1;
  }
  if (r.status === "no-valkey") {
    console.error("[restore-domain-db] Valkey unavailable — nothing restored");
    return 1;
  }
  console.log(
    `[restore-domain-db] snapshot ${r.snapshotCreated}: restored ${r.restored}, skipped ${r.skipped} of ${r.total}`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.stack : err);
      process.exit(1);
    });
}
