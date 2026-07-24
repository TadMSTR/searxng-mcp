// Single source of truth for the package version. Read at runtime from the
// nearest package.json so the McpServer version, OTel tracer/meter version, and
// the outbound USER_AGENT never drift from package.json again (they used to be
// hardcoded to 3.10.0 / 3.5.0 / 3.7.0 independently).
//
// Resolved by walking up from this module's directory, which works for both the
// source layout (tests run TS from src/) and the built layout (node runs
// build/src/) without a compile-time JSON import (nodenext would need an import
// attribute and tsc does not copy package.json into the build output).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (
        pkg.name === "@tadmstr/searxng-mcp" &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const VERSION = resolveVersion();
