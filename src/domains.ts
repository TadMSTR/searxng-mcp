import { readFileSync, watchFile } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logInfo, logWarn } from "./log.js";
import type { DomainConfig, SearxResult, TierSlot } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// From build/src/ (or src/ under a test runner) two levels up: the package
// root, which is /app in the container image.
const DOMAINS_PATH = resolve(__dirname, "../../domains.json");

let domainConfig: DomainConfig = { boost: [], block: [], profiles: {} };

/**
 * Read domains.json (default: the package root's copy). Logs one line with the
 * counts on success, and a WARNING naming the path when the file can't be read
 * or parsed. A missing file is not fatal: library users may not ship one, and
 * every list then stays empty.
 *
 * The images shipped without this file until 4.0.0 and nothing said so, so the
 * llms.txt allowlist, boost/block lists and profiles were all empty in every
 * container. The counts line is what CI's image smoke test checks.
 */
export function loadDomainConfig(path: string = DOMAINS_PATH): void {
  try {
    const raw = readFileSync(path, "utf-8");
    // Parsed into a local first: a file holding `null` or a bare value used to
    // replace the live config and then throw on the first `??=`, leaving the
    // module with a null config that every later lookup crashed on.
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new SyntaxError("top level is not an object");
    }
    const next = parsed as DomainConfig;
    next.boost ??= [];
    next.block ??= [];
    next.profiles ??= {};
    next.llms_txt ??= [];
    next.adblock_skip ??= [];
    domainConfig = next;
    logInfo(
      `domains: llms_txt=${next.llms_txt.length} boost=${next.boost.length} block=${next.block.length} profiles=${Object.keys(next.profiles).length}`,
    );
  } catch (err) {
    // Keep the previous config: empty at startup, the last good one on a hot
    // reload of a half-written file.
    const reason =
      err instanceof SyntaxError
        ? "not valid JSON"
        : ((err as NodeJS.ErrnoException).code ?? "unreadable");
    logWarn(
      `WARNING: domains config ${path} not loaded (${reason}); keeping the previous one (at startup: empty llms.txt allowlist, boost/block lists and profiles)`,
    );
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
// (Wrapped: watchFile passes Stats objects, which must not land in `path`.)
watchFile(DOMAINS_PATH, { interval: 5000 }, () => loadDomainConfig());

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
