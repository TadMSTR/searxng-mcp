/**
 * The `domain_stats` structured-output contract (vikunja#637).
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOT USE `.parse()`
 *
 * v3.19.0 added a sixth tier slot (`solver`) to `TIER_SLOT_KEYS`. Both payload
 * builders derive their `tiers` object from that constant, so both grew the
 * slot. `AllTiersOutputSchema` hand-listed five. Every `domain_stats` call on a
 * solver-enabled deployment then failed with:
 *
 *     Additional properties are not allowed ('solver' was unexpected)
 *
 * ...and 735 tests stayed green throughout, because the three existing
 * assertions in tools.test.ts use `toMatchObject`, which is non-exhaustive.
 *
 * The obvious remedy — "parse a real payload with the declared zod schema" —
 * DOES NOT WORK, and getting that wrong would leave this whole class of defect
 * just as invisible as it was before. Two facts about the real validation path:
 *
 *   1. Server-side, the SDK calls `safeParseAsync(outputSchema, payload)`.
 *      zod's `z.object()` is *strip*, not *strict*: an unrecognised key is
 *      silently removed and the parse SUCCEEDS. The server never rejected
 *      anything. Verified against zod 3.25 — `S.parse({known, bogus})` returns
 *      `{known}` without throwing.
 *   2. Client-side, the SDK advertises `toJsonSchemaCompat(outputSchema)` in
 *      tools/list, and that conversion emits `additionalProperties: false`.
 *      THAT is what rejected the call. The error we saw in production came
 *      from the client's JSON Schema validator, not from zod.
 *
 * So the contract that actually binds is the *derived JSON Schema*, and that is
 * what these tests validate against — using the SDK's own converter and the
 * SDK's own validator, i.e. the exact artefact and the exact code path a client
 * uses. A `.parse()` test here would have passed on the broken build.
 */

import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(0),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

import { cacheGet, getValkey } from "../src/cache.js";
import { type DomainRecord, TIER_SLOT_KEYS } from "../src/domain-db.js";
import { DomainStatsOutputSchema, handleDomainStats } from "../src/tools.js";

// The advertised contract, derived exactly as McpServer derives it for
// tools/list (see server/mcp.js — `toJsonSchemaCompat(obj, { strictUnions:
// true, pipeStrategy: 'output' })`). Options must stay in step with that call.
const ADVERTISED_SCHEMA = toJsonSchemaCompat(DomainStatsOutputSchema, {
  strictUnions: true,
  pipeStrategy: "output",
});

const validator = new AjvJsonSchemaValidator();

async function validateAsClient(payload: unknown) {
  const validate = await validator.getValidator(ADVERTISED_SCHEMA);
  return validate(payload);
}

interface TiersNode {
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * The `tiers` subschema as advertised. Only `record` carries the expanded
 * definition — `aggregate.tiers` is emitted as a `$ref` to it, which is exactly
 * why both tool modes broke together in #637 and why fixing one fixes both.
 * That relationship is asserted below rather than assumed.
 */
function advertisedTiers(): TiersNode {
  const schema = ADVERTISED_SCHEMA as unknown as {
    properties: {
      record: { anyOf: [{ properties: { tiers: TiersNode } }] };
      aggregate: { anyOf: [{ properties: { tiers: { $ref?: string } } }] };
    };
  };
  return schema.properties.record.anyOf[0].properties.tiers;
}

const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: NOW };
}

/**
 * `slots` is spelled as an explicit list rather than defaulted to "all", so a
 * test that wants a *partial* record cannot get a complete one by accident.
 */
function mkRecord(
  domain: string,
  slots: readonly (typeof TIER_SLOT_KEYS)[number][],
  overrides: Partial<DomainRecord["tier_stats_30d"]> = {},
): DomainRecord {
  return {
    schema_version: 7,
    domain,
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-06-01T00:00:00Z",
    capabilities: {},
    tier_stats_30d: {
      ...Object.fromEntries(slots.map((s) => [s, stat(0, 0, 0)])),
      ...overrides,
    } as DomainRecord["tier_stats_30d"],
  };
}

describe("domain_stats advertised output schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── The schema is derived, not restated ───────────────────────────────────

  it("advertises exactly the slots in TIER_SLOT_KEYS, no more and no fewer", () => {
    expect(Object.keys(advertisedTiers().properties).sort()).toEqual(
      [...TIER_SLOT_KEYS].sort(),
    );
  });

  it("covers both tool modes from one definition — aggregate.tiers $refs record.tiers", () => {
    // #637 broke `single` and `aggregate` simultaneously because they share
    // this one node. If a future change gives them separate definitions, the
    // single-definition assumption the rest of this file rests on is void.
    const aggregateTiers = (
      ADVERTISED_SCHEMA as unknown as {
        properties: {
          aggregate: { anyOf: [{ properties: { tiers: { $ref?: string } } }] };
        };
      }
    ).properties.aggregate.anyOf[0].properties.tiers;

    expect(aggregateTiers.$ref).toBe(
      "#/properties/record/anyOf/0/properties/tiers",
    );
  });

  it("keeps additionalProperties:false — the strictness that makes this suite meaningful", () => {
    // If this ever flips to true the payload/schema drift becomes unobservable
    // again and every other test in this file silently stops proving anything.
    expect(advertisedTiers().additionalProperties).toBe(false);
  });

  it("marks no slot required — tier4 needs WAYBACK_ENABLED, solver needs SOLVER_ENABLED", () => {
    // Requiring them does not fix #637, it inverts which deployments it breaks.
    const required = advertisedTiers().required ?? [];
    for (const slot of TIER_SLOT_KEYS) {
      expect(required).not.toContain(slot);
    }
  });

  // ── Real payloads, validated the way a client validates them ──────────────

  it("accepts a real single-mode payload carrying every slot", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(
        mkRecord("docs.example.com", TIER_SLOT_KEYS, {
          tier1: stat(10, 9, 1),
        }),
      ),
    );
    const result = await handleDomainStats({ hostname: "docs.example.com" });

    // Guard the guard: if the payload stopped carrying all six slots this test
    // would pass for the wrong reason, since absent slots are legal.
    expect(
      Object.keys(result.structuredContent.record?.tiers ?? {}).sort(),
    ).toEqual([...TIER_SLOT_KEYS].sort());

    const r = await validateAsClient(result.structuredContent);
    expect(r.valid, JSON.stringify(r.errors ?? r.error)).toBe(true);
  });

  it("accepts a real aggregate-mode payload carrying every slot", async () => {
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:good.com"]]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([
          JSON.stringify(
            mkRecord("good.com", TIER_SLOT_KEYS, { tier1: stat(10, 9, 1) }),
          ),
        ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    expect(
      Object.keys(result.structuredContent.aggregate?.tiers ?? {}).sort(),
    ).toEqual([...TIER_SLOT_KEYS].sort());

    const r = await validateAsClient(result.structuredContent);
    expect(r.valid, JSON.stringify(r.errors ?? r.error)).toBe(true);
  });

  it("accepts the found=false payload", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(null);
    const result = await handleDomainStats({ hostname: "missing.example.com" });
    const r = await validateAsClient(result.structuredContent);
    expect(r.valid, JSON.stringify(r.errors ?? r.error)).toBe(true);
  });

  it("accepts a record predating Wayback and the solver — slots absent, not null", async () => {
    // The deployment shape `tier4`/`solver` being `required` would have broken.
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(mkRecord("old.example.com", ["tier1", "tier2", "tier3"])),
    );
    const result = await handleDomainStats({ hostname: "old.example.com" });
    const r = await validateAsClient(result.structuredContent);
    expect(r.valid, JSON.stringify(r.errors ?? r.error)).toBe(true);
  });

  // ── Window and schema reporting (vikunja#686) ─────────────────────────────

  it("delivers schema_version and the real window to the caller, not just the text", async () => {
    // The declared schema is what binds: the SDK strips undeclared keys before
    // the payload leaves the server, so a field the handler builds but the
    // schema omits reaches nobody. Asserting it on the handler's return value
    // alone would pass in exactly that case.
    const oldest = NOW - 14 * 3600_000;
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:good.com"]]),
      mget: vi.fn().mockResolvedValueOnce([
        JSON.stringify(
          mkRecord("good.com", TIER_SLOT_KEYS, {
            tier1: { attempts: 10, ok: 9, fail: 1, window_start_ms: oldest },
          }),
        ),
      ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    const agg = result.structuredContent.aggregate;

    expect(agg?.schema_version).toBe(7);
    expect(agg?.window.oldest_sample_ms).toBe(oldest);
    expect(agg?.window.elapsed_ms).toBeGreaterThan(13 * 3600_000);
    // The ceiling is reported separately, and is NOT the measured window —
    // conflating the two is the whole defect.
    expect(agg?.window.ttl_ceiling_ms).toBe(30 * 24 * 3600_000);
    expect(agg?.window.elapsed_ms).toBeLessThan(
      agg?.window.ttl_ceiling_ms ?? 0,
    );

    const r = await validateAsClient(result.structuredContent);
    expect(r.valid, JSON.stringify(r.errors ?? r.error)).toBe(true);
  });

  it("reports no window when nothing has been counted, rather than a fabricated one", async () => {
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:idle.com"]]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([
          JSON.stringify(mkRecord("idle.com", TIER_SLOT_KEYS)),
        ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    const agg = result.structuredContent.aggregate;

    // Zeroed slots carry a window_start_ms too. Counting them would report a
    // measurement period over which nothing was measured.
    expect(agg?.window.oldest_sample_ms).toBeNull();
    expect(agg?.window.elapsed_ms).toBeNull();

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("no samples yet");
    expect(text).not.toMatch(/window \d/);
  });

  it("no longer prints a constant 30d window header", async () => {
    // The precise misreport: an aggregate taken minutes after a schema reset
    // presented as thirty days of evidence.
    const oldest = NOW - 2 * 3600_000;
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:good.com"]]),
      mget: vi.fn().mockResolvedValueOnce([
        JSON.stringify(
          mkRecord("good.com", TIER_SLOT_KEYS, {
            tier1: { attempts: 10, ok: 9, fail: 1, window_start_ms: oldest },
          }),
        ),
      ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const text = (await handleDomainStats({})).content[0]?.text ?? "";

    expect(text).toContain("all domains, window 2h since ");
    expect(text).toContain("schema 7");
    expect(text).not.toContain("all domains, 30d window");
  });

  it("renders a low-confidence marker below the threshold and a rate above it", async () => {
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:thin.com"]]),
      mget: vi.fn().mockResolvedValueOnce([
        JSON.stringify(
          mkRecord("thin.com", TIER_SLOT_KEYS, {
            // n=4: one outcome either way moves the rate by 25 points.
            tier1: { attempts: 4, ok: 0, fail: 4, window_start_ms: NOW },
            // n=5: the first sample size the rate is rendered for.
            tier2: { attempts: 5, ok: 0, fail: 5, window_start_ms: NOW },
          }),
        ),
      ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const text = (await handleDomainStats({})).content[0]?.text ?? "";

    expect(text).toContain("tier1  : insufficient data (0/4)");
    expect(text).toContain("tier2  : 0% ok (0/5)");
    // "no data" must stay distinct from "barely any data" — three states, not
    // two.
    expect(text).toContain("tier3  : no data");
  });

  // ── Negative controls ─────────────────────────────────────────────────────
  //
  // Without these the suite above cannot fail: a schema that accepted anything
  // would satisfy every positive assertion.

  it("rejects an aggregate missing the new window block", async () => {
    // Guards the declaration itself. If schema_version/window were dropped from
    // AggregateOutputSchema the positive tests above would still pass on the
    // handler's return value, because they read it before the SDK strips it.
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan: vi.fn().mockResolvedValueOnce(["0", ["domain:good.com"]]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([
          JSON.stringify(mkRecord("good.com", TIER_SLOT_KEYS)),
        ]),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    const tampered = structuredClone(result.structuredContent) as {
      aggregate: Record<string, unknown>;
    };
    delete tampered.aggregate.window;

    const r = await validateAsClient(tampered);
    expect(r.valid).toBe(false);
  });

  it("rejects a slot that is not in TIER_SLOT_KEYS", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(mkRecord("bogus.example.com", TIER_SLOT_KEYS)),
    );
    const result = await handleDomainStats({ hostname: "bogus.example.com" });
    const tampered = structuredClone(result.structuredContent) as {
      record: { tiers: Record<string, unknown> };
    };
    tampered.record.tiers.tier9 = stat(1, 1, 0);

    const r = await validateAsClient(tampered);
    expect(r.valid).toBe(false);
  });

  it("reproduces vikunja#637: a hand-listed five-slot schema rejects the real payload", async () => {
    // This is the regression itself, held in place. If someone reverts the
    // derivation to a literal that omits a slot, THIS is the shape that breaks
    // — and it breaks here rather than in production.
    const TierStats = z.object({
      attempts: z.number(),
      ok: z.number(),
      fail: z.number(),
      success_rate: z.number().nullable(),
    });
    const handListedFive = z.object(
      Object.fromEntries(
        TIER_SLOT_KEYS.slice(0, 5).map((s) => [s, TierStats]),
      ) as Record<string, typeof TierStats>,
    );
    const staleSchema = toJsonSchemaCompat(
      z.object({ tiers: handListedFive }),
      { strictUnions: true, pipeStrategy: "output" },
    );

    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(mkRecord("docs.example.com", TIER_SLOT_KEYS)),
    );
    const result = await handleDomainStats({ hostname: "docs.example.com" });

    const validateStale = await validator.getValidator(staleSchema);
    const stale = await validateStale({
      tiers: result.structuredContent.record?.tiers,
    });
    expect(stale.valid).toBe(false);

    // ...and the schema actually shipped accepts the very same payload.
    const live = await validateAsClient(result.structuredContent);
    expect(live.valid, JSON.stringify(live.errors ?? live.error)).toBe(true);
  });
});
