// Concurrency proof for the domain-db write path, against a REAL Valkey.
//
// This exists because the unit-level equivalent could not have caught the bug
// it is here to prevent. `tests/domain-db.test.ts` stubs `cacheAtomicUpdate`
// out with a synchronous in-process closure, and single-threaded JS serializes
// a synchronous closure perfectly — so it asserted the contract while the
// implementation was what failed. An in-memory emulator is no better: the
// original defect was connection-scoped WATCH semantics, which an emulator does
// not model. Nothing short of a real server proves this.
//
// Gated on VALKEY_TEST_URL so CI without a Valkey skips rather than fails:
//   VALKEY_TEST_URL=redis://:$SEARXNG_DRAGONFLY_PASSWORD@localhost:6381/9 pnpm test

import type { Redis as Valkey } from "iovalkey";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const TEST_URL = process.env.VALKEY_TEST_URL;

// The live cache is db 1 and the domain records under test share its `domain:*`
// namespace, so a misaimed test URL would corrupt production data rather than
// just fail. Refuse anything but an explicit scratch index.
function assertScratchDb(url: string): void {
  const index = new URL(url).pathname.replace(/^\//, "");
  if (index === "" || index === "0" || index === "1") {
    throw new Error(
      `VALKEY_TEST_URL must name a scratch db index (got ${index || "none"}); ` +
        `db 1 is the live cache and db 0 is the default — use e.g. .../9`,
    );
  }
}

if (TEST_URL) {
  assertScratchDb(TEST_URL);
  // config.ts resolves CACHE_URL at module load, so this must be set before the
  // src modules are imported below.
  process.env.CACHE_URL = TEST_URL;
}

const { getValkey } = await import("../../src/cache.js");
const {
  domainKey,
  getDomainRecord,
  recordMetadataFetchAttempt,
  recordPostExtractSample,
  recordTierAttempt,
} = await import("../../src/domain-db.js");

// Unique per run so a crashed run can't poison the next one, and so parallel
// invocations don't collide on the scratch db.
let counter = 0;
const runId = process.pid.toString(36);
const nextHost = () => `concurrency-${runId}-${counter++}.test.invalid`;
const touched: string[] = [];
const host = () => {
  const h = nextHost();
  touched.push(domainKey(h));
  return h;
};

describe.skipIf(!TEST_URL)("domain-db concurrency (real Valkey)", () => {
  // No afterAll quit here: getValkey() caches a module-level singleton, so
  // closing it would leave the CAS suite below holding a dead client. The last
  // suite in the file owns the teardown.
  afterEach(async () => {
    const client = await getValkey();
    if (client && touched.length > 0) await client.del(touched);
    touched.length = 0;
  });

  it("lands all three concurrent writers on the same record", async () => {
    const hostname = host();

    // The exact interleaving fetchPage produces: a tier attempt, a metadata
    // fetch and a post-extract sample, all fire-and-forget against one
    // `domain:<host>` key. Under WATCH/MULTI/EXEC on the shared singleton
    // connection, the losing writes were discarded with no error — which is why
    // `capabilities.metadata_fetch` was populated on 0 of 572 live records.
    await Promise.all([
      recordTierAttempt(`https://${hostname}/a`, "tier1_firecrawl", "hit"),
      recordMetadataFetchAttempt(`https://${hostname}/a`, true),
      recordPostExtractSample(`https://${hostname}/a`, {
        jsonLdPresent: true,
        ogTitlePresent: true,
      }),
    ]);

    const record = await getDomainRecord(hostname);
    expect(record).not.toBeNull();
    expect(record?.tier_stats_30d.tier1.attempts).toBe(1);
    expect(record?.tier_stats_30d.tier1.ok).toBe(1);
    expect(record?.capabilities.metadata_fetch?.attempts).toBe(1);
    expect(record?.capabilities.metadata_fetch?.ok).toBe(1);
    expect(record?.capabilities.json_ld_article?.sampled).toBe(1);
    expect(record?.capabilities.og_title?.sampled).toBe(1);
  });

  it("loses no updates at N=50 concurrent writers on one key", async () => {
    const hostname = host();
    const N = 50;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordTierAttempt(
          `https://${hostname}/p${i}`,
          "tier1_firecrawl",
          i % 2 === 0 ? "hit" : "miss",
          i % 2 === 0 ? undefined : "synthetic",
        ),
      ),
    );

    const record = await getDomainRecord(hostname);
    expect(record?.tier_stats_30d.tier1.attempts).toBe(N);
    expect(record?.tier_stats_30d.tier1.ok).toBe(N / 2);
    expect(record?.tier_stats_30d.tier1.fail).toBe(N / 2);
  });

  it("interleaves distinct writer types without loss at N=50", async () => {
    const hostname = host();
    const N = 50;

    // Mixed writers touch different sub-objects of the same document, so a lost
    // update shows up as a starved field rather than a low count — the exact
    // shape of the production symptom.
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const url = `https://${hostname}/p${i}`;
        if (i % 3 === 0) {
          return recordTierAttempt(url, "tier3_rawfetch", "hit");
        }
        if (i % 3 === 1) return recordMetadataFetchAttempt(url, true);
        return recordPostExtractSample(url, {
          jsonLdPresent: true,
          ogTitlePresent: false,
        });
      }),
    );

    const record = await getDomainRecord(hostname);
    const tier = Math.ceil(N / 3);
    const meta = Math.ceil((N - 1) / 3);
    expect(record?.tier_stats_30d.tier3.attempts).toBe(tier);
    expect(record?.capabilities.metadata_fetch?.attempts).toBe(meta);
    expect(record?.capabilities.json_ld_article?.sampled).toBe(N - tier - meta);
    expect(record?.capabilities.og_title?.present).toBe(0);
  });
});

describe.skipIf(!TEST_URL)("cacheAtomicUpdate compare-and-set", () => {
  // The in-process queue above cannot serialize a writer in another process, so
  // these cover the half of the fix that only the server-side CAS provides.
  // They are the regression guard against a future simplification that keeps
  // the queue and drops the Lua script: with the CAS gone, all three fail.
  //
  // The conflict is injected at the read rather than raced. Racing a second
  // connection against the CAS is not deterministic — the two commands travel
  // over separate sockets with no ordering guarantee — and a stale read is
  // precisely what a lost race produces, so injecting it tests the same
  // condition without the flake.

  // iovalkey's `get` is overloaded for the callback form; narrow to the shape
  // this file patches.
  type Getter = { get(key: string): Promise<string | null> };

  async function withStaleReads<T>(
    injected: (string | null)[],
    body: () => Promise<T>,
  ): Promise<T> {
    const client = (await getValkey()) as unknown as Getter;
    const realGet = client.get.bind(client);
    const queue = [...injected];
    client.get = (key: string) =>
      queue.length > 0
        ? Promise.resolve(queue.shift() as string | null)
        : realGet(key);
    try {
      return await body();
    } finally {
      client.get = realGet;
    }
  }

  afterAll(async () => {
    const client = await getValkey();
    if (client && touched.length > 0) await client.del(touched);
    touched.length = 0;
    if (client) await client.quit();
  });

  it("rejects a stale commit and re-applies against the stored value", async () => {
    const { cacheAtomicUpdate } = await import("../../src/cache.js");
    const client = (await getValkey()) as Valkey;
    const key = `domain:cas-${runId}-${counter++}.test.invalid`;
    touched.push(key);

    // Stored value is {n:99}; the first read is served {n:1}, as it would be if
    // another process committed between the read and the CAS.
    await client.set(key, JSON.stringify({ n: 99 }), "EX", 60);

    const seen: number[] = [];
    await withStaleReads([JSON.stringify({ n: 1 })], () =>
      cacheAtomicUpdate(key, 60, (raw) => {
        const value = JSON.parse(raw as string) as { n: number };
        seen.push(value.n);
        return JSON.stringify({ n: value.n + 1 });
      }),
    );

    // Second entry proves the retry re-read rather than replaying its own base.
    expect(seen).toEqual([1, 99]);
    const final = JSON.parse((await client.get(key)) as string) as {
      n: number;
    };
    expect(final.n).toBe(100); // 99+1, not 2 — the stale write never landed
  });

  it("refuses a create when the key appeared since the read", async () => {
    const { cacheAtomicUpdate } = await import("../../src/cache.js");
    const client = (await getValkey()) as Valkey;
    const key = `domain:cas-create-${runId}-${counter++}.test.invalid`;
    touched.push(key);

    await client.set(key, "squatter", "EX", 60);

    const raws: (string | null)[] = [];
    await withStaleReads([null], () =>
      cacheAtomicUpdate(key, 60, (raw) => {
        raws.push(raw);
        return "mine";
      }),
    );

    expect(raws).toEqual([null, "squatter"]);
    expect(await client.get(key)).toBe("mine");
  });

  it("commits a create when the key really is absent", async () => {
    const { cacheAtomicUpdate } = await import("../../src/cache.js");
    const client = (await getValkey()) as Valkey;
    const key = `domain:cas-new-${runId}-${counter++}.test.invalid`;
    touched.push(key);

    // The miss branch needs its own coverage: a non-existent key reads as Lua
    // `false`, which is unequal to every string including the empty one, so a
    // CAS that compared naively would reject every create and the DB would
    // never gain a record at all.
    const raws: (string | null)[] = [];
    await cacheAtomicUpdate(key, 60, (raw) => {
      raws.push(raw);
      return "created";
    });

    expect(raws).toEqual([null]); // committed first try, no retry
    expect(await client.get(key)).toBe("created");
    expect(await client.ttl(key)).toBeGreaterThan(0); // TTL applied, not persisted
  });
});
