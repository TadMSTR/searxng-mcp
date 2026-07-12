#!/usr/bin/env node
// Operator CLI: pretty-print the domain capability record for a hostname.
// Usage: pnpm dump-domain docs.anthropic.com

import {
  getDomainRecord,
  normalizeHostname,
  type TierStat,
} from "../domain-db.js";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function tierSummary(label: string, stat: TierStat): string {
  const successRate =
    stat.attempts > 0
      ? `${Math.round((stat.ok / stat.attempts) * 100)}% ok (${stat.ok}/${stat.attempts})`
      : "no data";
  const msLeft = WINDOW_MS - (Date.now() - stat.window_start_ms);
  const daysLeft = Math.max(0, Math.round(msLeft / 86400000));
  const windowInfo = `window resets in ~${daysLeft}d`;
  const failNote = stat.last_fail_reason
    ? ` | last fail: ${stat.last_fail_reason}`
    : "";
  return `  ${label}: ${successRate} | ${windowInfo}${failNote}`;
}

export async function main(): Promise<number> {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: dump-domain <hostname-or-url>");
    return 2;
  }

  const hostname = normalizeHostname(target);
  if (!hostname) {
    console.error(`could not parse hostname from: ${target}`);
    return 2;
  }

  const record = await getDomainRecord(hostname);
  if (!record) {
    console.log(`no record for ${hostname}`);
    return 0;
  }

  console.log(JSON.stringify(record, null, 2));
  console.log("\n--- tier stats (30d window) ---");
  console.log(tierSummary("tier1 (firecrawl)", record.tier_stats_30d.tier1));
  console.log(tierSummary("tier2 (crawl4ai) ", record.tier_stats_30d.tier2));
  console.log(tierSummary("tier3 (raw)      ", record.tier_stats_30d.tier3));
  console.log(tierSummary("tier4 (wayback)  ", record.tier_stats_30d.tier4));
  console.log(tierSummary("github (fastpath)", record.tier_stats_30d.github));

  const meta = record.capabilities.metadata_fetch;
  console.log(
    meta
      ? `  metadata_fetch   : ${Math.round((meta.ok / meta.attempts) * 100)}% ok (${meta.ok}/${meta.attempts}) | last checked: ${meta.last_checked}`
      : "  metadata_fetch   : no data",
  );

  const seen = record.capabilities.seen_in_search;
  console.log(
    seen
      ? `  seen_in_search   : ${seen.count}x | last seen: ${seen.last_seen_at}`
      : "  seen_in_search   : never seen in search results",
  );

  return 0;
}

// Guard the auto-invocation so importing this module (e.g. in tests) doesn't
// trigger process.exit — only run when executed directly as a CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.stack : err);
      process.exit(1);
    });
}
