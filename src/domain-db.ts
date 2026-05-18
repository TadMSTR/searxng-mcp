// Per-domain capability database. Backed by Valkey under the `domain:*`
// namespace (no overlap with existing `fetch:`, `search:`, `robots:`, `llms:`
// or `embed:` prefixes). Each record captures what we've learned about a
// domain across fetches: tier success rates, presence of llms.txt /
// robots.txt, post-extraction sampling, etc.
//
// Writes are best-effort and fire-and-forget: a failure here must never
// surface to the caller of fetchPage.

import { cacheGet, cacheSet } from "./cache.js";

const DOMAIN_RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
const SCHEMA_VERSION = 2;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type TierName = "tier1_firecrawl" | "tier2_crawl4ai" | "tier3_rawfetch";
export type PreferredStrategy = "llms_full_txt" | "tier1" | "tier2" | "tier3";

export interface TierStat {
  attempts: number;
  ok: number;
  fail: number;
  last_fail_reason?: string;
  window_start_ms: number;
}

export interface DomainCapabilities {
  llms_txt?: {
    present: boolean;
    url?: string;
    last_checked: string;
  };
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
  };
  preferred_strategy?: PreferredStrategy;
  notes?: string;
}

function emptyStat(): TierStat {
  return { attempts: 0, ok: 0, fail: 0, window_start_ms: Date.now() };
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

function domainKey(hostname: string): string {
  return `domain:${hostname}`;
}

export async function getDomainRecord(
  hostnameOrUrl: string,
): Promise<DomainRecord | null> {
  const hostname = normalizeHostname(hostnameOrUrl);
  if (!hostname) return null;
  const raw = await cacheGet(domainKey(hostname));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DomainRecord;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRecord(record: DomainRecord): Promise<void> {
  await cacheSet(
    domainKey(record.domain),
    JSON.stringify(record),
    DOMAIN_RECORD_TTL_SECONDS,
  );
}

// Per-hostname write queue. Multiple recorders (tier-attempt, robots probe,
// post-extract sample, llms.txt probe) can run concurrently for the same
// fetch; without serialization their read-modify-write cycles race and the
// last writer overwrites the others' changes. Chaining new writes onto the
// previous promise gives sequential, in-order updates per hostname while
// keeping different hostnames fully parallel.
const writeLocks = new Map<string, Promise<void>>();

async function performUpdate(
  hostname: string,
  mutate: (r: DomainRecord) => void,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const existing = await getDomainRecord(hostname);
    const record = existing ?? newRecord(hostname, now);
    mutate(record);
    record.last_fetch = now;
    await writeRecord(record);
  } catch {
    // best-effort — never throw from a DB hook
  }
}

function updateRecord(
  hostnameOrUrl: string,
  mutate: (r: DomainRecord) => void,
): Promise<void> {
  const hostname = normalizeHostname(hostnameOrUrl);
  if (!hostname) return Promise.resolve();
  const prev = writeLocks.get(hostname) ?? Promise.resolve();
  const next = prev.then(() => performUpdate(hostname, mutate));
  writeLocks.set(
    hostname,
    next.finally(() => {
      // Clear the lock entry once this update settles, but only if no
      // newer update has chained on (which would have overwritten it).
      if (writeLocks.get(hostname) === next) writeLocks.delete(hostname);
    }),
  );
  return next;
}

export function _clearWriteLocksForTests(): void {
  writeLocks.clear();
}

const TIER_KEY: Record<TierName, "tier1" | "tier2" | "tier3"> = {
  tier1_firecrawl: "tier1",
  tier2_crawl4ai: "tier2",
  tier3_rawfetch: "tier3",
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
