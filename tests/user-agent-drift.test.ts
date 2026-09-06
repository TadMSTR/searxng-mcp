// vikunja#641 — the outbound User-Agent must come from package.json, always.
//
// This is the third time the class has appeared. src/version.ts was introduced
// to end it, and its own header records the first round: "they used to be
// hardcoded to 3.10.0 / 3.5.0 / 3.7.0 independently". Three more had drifted
// again by 3.23.0 — llms-txt.ts claiming 3.8.0, reddit.ts and youtube.ts both
// claiming 3.15.0. The ticket named only the first.
//
// So the fix is not three more edits; it is a check that fails the next one.
// Every outbound request from this server identifies the software to a third
// party, and a version that is fifteen releases stale is a plain untruth about
// who is calling — the thing a User-Agent exists to say.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USER_AGENT } from "../src/fetch-utils.js";
import { VERSION } from "../src/version.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("outbound User-Agent", () => {
  it("is built from the package version", () => {
    expect(USER_AGENT).toContain(`searxng-mcp/${VERSION}`);
  });

  it("reports the version package.json actually declares", () => {
    // Read package.json directly rather than trusting VERSION, which is what
    // resolveVersion() returns and would agree with itself even if the walk-up
    // silently fell through to its "0.0.0" default.
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0");
  });

  it("is not hardcoded anywhere in src/", () => {
    // The guard. A literal `searxng-mcp/<semver>` in source is a version that
    // cannot follow a release, which is exactly how all six previous instances
    // came about.
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const body = readFileSync(file, "utf8");
      for (const [i, line] of body.split("\n").entries()) {
        // Skip comments — the version.ts header legitimately quotes the old
        // hardcoded values while explaining why they must not come back.
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*")) continue;
        if (/["'`]searxng-mcp\/\d+\.\d+\.\d+/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is the same string on every outbound path", () => {
    // reddit.ts and youtube.ts each had their own constant, which is how they
    // drifted together to 3.15.0 while llms-txt.ts sat at 3.8.0. There should
    // be exactly one definition.
    const definitions = tsFiles(SRC).filter((file) =>
      /^\s*export const USER_AGENT\s*=/m.test(readFileSync(file, "utf8")),
    );
    expect(definitions.map((f) => f.slice(SRC.length + 1))).toEqual([
      "fetch-utils.ts",
    ]);
  });
});
