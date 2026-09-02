// Per-domain capability database. Backed by Valkey under the `domain:*`
// namespace (no overlap with existing `fetch:`, `search:`, `robots:`, `llms:`
// or `embed:` prefixes). Each record captures what we've learned about a
// domain across fetches: tier success rates, presence of llms.txt /
// robots.txt, post-extraction sampling, etc.
//
// Writes are best-effort and fire-and-forget: a failure here must never
// surface to the caller of fetchPage.

import { cacheAtomicUpdate, cacheGet } from "./cache.js";

export const DOMAIN_RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
// Bumped 3->4 to add the `github` fast-path slot to tier_stats_30d (SXNG-10 —
// GitHub fetches previously bypassed runTier() and recorded no tier stats).
// Existing records on schema 3 are treated as stale and rebuilt fresh (see
// updateRecord), same migration approach used for the 1->2 and 2->3 bumps.
// Bumped 4->5 to discard tier stats accumulated while cacheAtomicUpdate was
// losing writes. The surviving numbers are a biased sample — whichever writer
// happened to win each race — and they drive tier-skip decisions, so they are
// discarded rather than migrated. Same approach as 1->2, 2->3 and 3->4.
// Bumped 5->6 to add the `solver` slot to tier_stats_30d for the challenge
// solver tier. Records on schema 5 are treated as stale and rebuilt fresh (see
// updateRecord), the same migration approach used for every bump before it —
// the alternative, back-filling an empty slot, would leave the record claiming
// a 30-day window it never measured. The reset is accepted (Ted, 2026-09-02):
// the v5 window only began 2026-08-19, so little is discarded.
export const SCHEMA_VERSION = 6;
export const TIER_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_MS = TIER_STATS_WINDOW_MS;

export type TierName =
  | "tier1_firecrawl"
  | "tier2_crawl4ai"
  | "tier3_rawfetch"
  | "tier4_wayback"
  // GitHub fast path (raw.githubusercontent.com / api.github.com / github.com
  // README fetches). Not a cascade tier — dispatched directly in fetchPage —
  // but routed through runTier() so its hit/miss/error is recorded like any
  // other tier.
  | "github"
  // Challenge solver (Byparr). Like tier4_wayback and github, a TierName with
  // no TierSlot: it is dispatched directly in fetchPage rather than being part
  // of the ordered cascade, so it stays out of computeTierSkips and the
  // tier_skip domain config entirely.
  | "solver_byparr";

/**
 * The tier_stats_30d slot keys — the single roster of this closed set.
 *
 * domain-stats.ts and domain-snapshot.ts both consume it rather than keeping
 * their own copy: a slot added here but missed in one of those lists would be
 * silently dropped from aggregation or silently rejected by the snapshot
 * restore guard, and neither array is exhaustiveness-checked by the compiler.
 */
export const TIER_SLOT_KEYS = [
  "tier1",
  "tier2",
  "tier3",
  "tier4",
  "github",
  "solver",
] as const;
export type TierSlotKey = (typeof TIER_SLOT_KEYS)[number];
export type PreferredStrategy = "llms_full_txt" | "tier1" | "tier2" | "tier3";

export interface TierStat {
  attempts: number;
  ok: number;
  fail: number;
  last_fail_reason?: string;
  window_start_ms: number;
}

export interface DomainCapabilities {
  // NOTE: a sibling `llms_txt` slot lived here with no writer and no reader
  // anywhere in src/, from the schema's first version. It was removed in the v5
  // bump rather than wired up: `llms_full_txt` is the probe that actually runs
  // and feeds preferred_strategy, and populating `llms_txt` would have meant
  // probing every domain for a signal nothing consumes. Declared-but-unwritten
  // schema reads as "we measure this" and invites exactly the false confidence
  // the mocked concurrency test produced.
  llms_full_txt?: {
    present: boolean;
    size_bytes?: number;
    last_checked: string;
  };
  robots_txt?: {
    present: boolean;
    fetched: string;
    allows_us: boolean;
  };
  json_ld_article?: {
    sampled: number;
    present: number;
    last_sampled_at: string;
  };
  og_title?: {
    sampled: number;
    present: number;
    last_sampled_at: string;
  };
  // Side-channel raw-HTML fetch used for JSON-LD/og:title sampling
  // (fetchRawHtmlForMetadata). Distinct from tier_stats_30d — this fetch
  // exists to sample metadata, not to deliver full page content, so a
  // "failure" here doesn't mean the domain is unreachable. Tracked so
  // dump-domain can answer "is this domain reachable at all" without
  // cross-referencing tier stats and post-extract sampling separately.
  metadata_fetch?: {
    attempts: number;
    ok: number;
    fail: number;
    last_checked: string;
  };
  // Lightweight signal that a domain showed up in search results, even if
  // it was never fetched. Lets dump-domain distinguish "never seen" from
  // "seen in search, never fetched."
  seen_in_search?: {
    count: number;
    last_seen_at: string;
  };
}

export interface DomainRecord {
  schema_version: number;
  domain: string;
  first_seen: string;
  last_fetch: string;
  capabilities: DomainCapabilities;
  tier_stats_30d: {
    tier1: TierStat;
    tier2: TierStat;
    tier3: TierStat;
    tier4: TierStat;
    github: TierStat;
    solver: TierStat;
  };
  preferred_strategy?: PreferredStrategy;
  notes?: string;
}

function emptyStat(): TierStat {
  return { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() };
}

/**
 * A TierStat as of `now`, with an elapsed window reported as empty.
 *
 * `tier_stats_30d` was never a 30-day window on read. The reset in
 * `recordTierAttempt` fires only on the *next write for that domain*, so a
 * domain fetched once and never revisited kept reporting those numbers until
 * the 90-day record TTL — grep.app's 0/10 was 26 days stale and still topping
 * the failing-domains list. Applying the cutoff at read time makes the window
 * mean what its name says regardless of write cadence.
 *
 * Every consumer must go through this: `routing.ts` thresholds on these counts
 * to skip tiers and `domain-stats.ts` reports them, and the two disagreeing
 * would be worse than either being wrong on its own. `window_start_ms` is
 * preserved so the "resets in ~Nd" hint still renders (as 0d, correctly).
 */
export function currentWindowStat(
  stat: TierStat | undefined,
  now: number = Date.now(),
): TierStat {
  if (!stat) return { attempts: 0, ok: 0, fail: 0, window_start_ms: now };
  if (now - stat.window_start_ms <= WINDOW_MS) return stat;
  return {
    attempts: 0,
    ok: 0,
    fail: 0,
    window_start_ms: stat.window_start_ms,
  };
}

function newRecord(domain: string, now: string): DomainRecord {
  return {
    schema_version: SCHEMA_VERSION,
    domain,
    first_seen: now,
    last_fetch: now,
    capabilities: {},
    tier_stats_30d: {
      tier1: emptyStat(),
      tier2: emptyStat(),
      tier3: emptyStat(),
      tier4: emptyStat(),
      github: emptyStat(),
      solver: emptyStat(),
    },
  };
}

export function normalizeHostname(input: string): string | null {
  try {
    // If `input` is a URL, pull the hostname; otherwise treat it as a hostname.
    const host = input.includes("://") ? new URL(input).hostname : input.trim();
    return host.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function domainKey(hostname: string): string {
  return `domain:${hostname}`;
}

/**
 * Parse a raw domain-db value, returning the record only if it is valid JSON
 * on the current schema. Stale-schema and malformed records return null — the
 * same staleness gate `getDomainRecord` applies, extracted so the bounded
 * enumeration in domain-stats.ts uses an identical contract.
 */
export function parseDomainRecord(raw: string | null): DomainRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DomainRecord;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getDomainRecord(
  hostnameOrUrl: string,
): Promise<DomainRecord | null> {
  const hostname = normalizeHostname(hostnameOrUrl);
  if (!hostname) return null;
  return parseDomainRecord(await cacheGet(domainKey(hostname)));
}

// Atomic read-modify-write via cacheAtomicUpdate, which pairs an in-process
// per-key queue with a server-side compare-and-set. The queue removes
// contention between this module's own fire-and-forget writers; the CAS covers
// writers in other processes. See the commentary in cache.ts — the previous
// WATCH/MULTI/EXEC implementation provided neither, because WATCH is scoped to
// the shared singleton connection rather than to the call.
function updateRecord(
  hostnameOrUrl: string,
  mutate: (r: DomainRecord) => void,
): Promise<void> {
  const hostname = normalizeHostname(hostnameOrUrl);
  if (!hostname) return Promise.resolve();
  const key = domainKey(hostname);
  const now = new Date().toISOString();
  return cacheAtomicUpdate(key, DOMAIN_RECORD_TTL_SECONDS, (raw) => {
    let record: DomainRecord;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DomainRecord;
        record =
          parsed.schema_version === SCHEMA_VERSION
            ? parsed
            : newRecord(hostname, now);
      } catch {
        record = newRecord(hostname, now);
      }
    } else {
      record = newRecord(hostname, now);
    }
    mutate(record);
    record.last_fetch = now;
    return JSON.stringify(record);
  });
}

const TIER_KEY: Record<TierName, TierSlotKey> = {
  tier1_firecrawl: "tier1",
  tier2_crawl4ai: "tier2",
  tier3_rawfetch: "tier3",
  tier4_wayback: "tier4",
  github: "github",
  solver_byparr: "solver",
};

export async function recordTierAttempt(
  url: string,
  tier: TierName,
  outcome: "hit" | "miss" | "error",
  failReason?: string,
): Promise<void> {
  const slot = TIER_KEY[tier];
  await updateRecord(url, (record) => {
    const stat = record.tier_stats_30d[slot];
    if (Date.now() - stat.window_start_ms > WINDOW_MS) {
      stat.attempts = 0;
      stat.ok = 0;
      stat.fail = 0;
      stat.window_start_ms = Date.now();
      delete stat.last_fail_reason;
    }
    stat.attempts += 1;
    if (outcome === "hit") {
      stat.ok += 1;
    } else {
      stat.fail += 1;
      if (failReason) stat.last_fail_reason = failReason;
    }
  });
}

export async function recordLlmsFullProbe(
  url: string,
  present: boolean,
  sizeBytes?: number,
): Promise<void> {
  await updateRecord(url, (record) => {
    record.capabilities.llms_full_txt = {
      present,
      last_checked: new Date().toISOString(),
      ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
    };
    if (present) record.preferred_strategy = "llms_full_txt";
  });
}

export async function recordRobotsProbe(
  url: string,
  present: boolean,
  allowsUs: boolean,
): Promise<void> {
  await updateRecord(url, (record) => {
    record.capabilities.robots_txt = {
      present,
      fetched: new Date().toISOString(),
      allows_us: allowsUs,
    };
  });
}

export async function recordPostExtractSample(
  url: string,
  signals: { jsonLdPresent: boolean; ogTitlePresent: boolean },
): Promise<void> {
  await updateRecord(url, (record) => {
    const now = new Date().toISOString();
    const jl = record.capabilities.json_ld_article ?? {
      sampled: 0,
      present: 0,
      last_sampled_at: now,
    };
    jl.sampled += 1;
    if (signals.jsonLdPresent) jl.present += 1;
    jl.last_sampled_at = now;
    record.capabilities.json_ld_article = jl;

    const og = record.capabilities.og_title ?? {
      sampled: 0,
      present: 0,
      last_sampled_at: now,
    };
    og.sampled += 1;
    if (signals.ogTitlePresent) og.present += 1;
    og.last_sampled_at = now;
    record.capabilities.og_title = og;
  });
}

export async function recordMetadataFetchAttempt(
  url: string,
  ok: boolean,
): Promise<void> {
  await updateRecord(url, (record) => {
    const stat = record.capabilities.metadata_fetch ?? {
      attempts: 0,
      ok: 0,
      fail: 0,
      last_checked: new Date().toISOString(),
    };
    stat.attempts += 1;
    if (ok) stat.ok += 1;
    else stat.fail += 1;
    stat.last_checked = new Date().toISOString();
    record.capabilities.metadata_fetch = stat;
  });
}

/**
 * Record that a domain appeared in search results. Cheap, best-effort — no
 * fetch is performed, this just marks the domain as "seen" so dump-domain
 * can distinguish it from a domain that's never shown up at all.
 */
export async function recordSearchAppearance(url: string): Promise<void> {
  await updateRecord(url, (record) => {
    const now = new Date().toISOString();
    const seen = record.capabilities.seen_in_search ?? {
      count: 0,
      last_seen_at: now,
    };
    seen.count += 1;
    seen.last_seen_at = now;
    record.capabilities.seen_in_search = seen;
  });
}

/**
 * Whether JSON-LD post-extraction should be skipped for this domain. Returns
 * true once we've sampled at least 5 pages and found no JSON-LD Article
 * schema in any of them.
 */
export async function shouldSkipJsonLdPostExtract(
  url: string,
): Promise<boolean> {
  const record = await getDomainRecord(url);
  const stat = record?.capabilities.json_ld_article;
  if (!stat) return false;
  return stat.sampled >= 5 && stat.present === 0;
}
