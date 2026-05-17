import { readFileSync, watchFile } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DomainConfig, SearxResult, TierSlot } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAINS_PATH = resolve(__dirname, "../../domains.json");

let domainConfig: DomainConfig = { boost: [], block: [], profiles: {} };

export function loadDomainConfig(): void {
  try {
    const raw = readFileSync(DOMAINS_PATH, "utf-8");
    domainConfig = JSON.parse(raw) as DomainConfig;
    domainConfig.boost ??= [];
    domainConfig.block ??= [];
    domainConfig.profiles ??= {};
    domainConfig.llms_txt ??= [];
    domainConfig.adblock_skip ??= [];
  } catch {
    // File missing or malformed — use empty config, no filtering applied
  }
}

export function getAdblockSkipList(): string[] {
  return domainConfig.adblock_skip ?? [];
}

export function getLlmsTxtAllowlist(): string[] {
  return domainConfig.llms_txt ?? [];
}

export function getOperatorTierSkips(url: string): TierSlot[] {
  const overrides = domainConfig.tier_skip;
  if (!overrides) return [];
  const skips = new Set<TierSlot>();
  for (const [pattern, tiers] of Object.entries(overrides)) {
    if (!Array.isArray(tiers)) continue;
    if (urlMatchesDomain(url, pattern)) {
      for (const t of tiers) skips.add(t);
    }
  }
  return Array.from(skips);
}

loadDomainConfig();
// Hot-reload: re-read domains.json whenever it changes without restarting the MCP server
watchFile(DOMAINS_PATH, { interval: 5000 }, loadDomainConfig);

export function getBlockList(profile?: string): string[] {
  const base = domainConfig.block;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].block ?? [])];
}

export function getBoostList(profile?: string): string[] {
  const base = domainConfig.boost;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].boost ?? [])];
}

export function urlMatchesDomain(url: string, pattern: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const pathname = new URL(url).pathname;
    // Pattern may be "domain.com" or "domain.com/path/prefix"
    if (pattern.includes("/")) {
      const [patDomain, ...patParts] = pattern.split("/");
      const patPath = `/${patParts.join("/")}`;
      return (
        (hostname === patDomain || hostname.endsWith(`.${patDomain}`)) &&
        pathname.startsWith(patPath)
      );
    }
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  } catch {
    return false;
  }
}

export function applyDomainFilters(
  results: SearxResult[],
  profile?: string,
): SearxResult[] {
  const blockList = getBlockList(profile);
  const boostList = getBoostList(profile);

  // Remove blocked domains
  const filtered = results.filter(
    (r) => !blockList.some((pat) => urlMatchesDomain(r.url, pat)),
  );

  // Stable sort: boosted domains float to the top, order within each group preserved
  const boosted = filtered.filter((r) =>
    boostList.some((pat) => urlMatchesDomain(r.url, pat)),
  );
  const normal = filtered.filter(
    (r) => !boostList.some((pat) => urlMatchesDomain(r.url, pat)),
  );

  return [...boosted, ...normal];
}
