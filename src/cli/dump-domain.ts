#!/usr/bin/env node
// Operator CLI: pretty-print the domain capability record for a hostname.
// Usage: pnpm dump-domain docs.anthropic.com

import { getDomainRecord, normalizeHostname } from "../domain-db.js";
import { formatDomainRecord } from "../domain-stats.js";

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
  console.log(`\n${formatDomainRecord(record)}`);
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
