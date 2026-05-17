#!/usr/bin/env node
// Operator CLI: pretty-print the domain capability record for a hostname.
// Usage: pnpm dump-domain docs.anthropic.com

import { getDomainRecord, normalizeHostname } from "../domain-db.js";

async function main(): Promise<number> {
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
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
