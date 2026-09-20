#!/usr/bin/env node
// Asserts that every GitHub Action used in this repository resolves to ONE ref
// across ALL workflows.
//
// WHY THIS EXISTS — vikunja#920.
//
// Commit 76c9969 (PR #50, the v3.29.0 build) added a new workflow
// (adblock-lists-refresh.yml) and a new ci.yml job (playwright-adblock) with the
// action SHAs hand-copied from an older revision. Three pins went back to
// pre-bump values, AFTER Dependabot had already bumped them and those PRs had
// merged. Dependabot then correctly re-filed the same two bumps (#51, #58) and
// nobody could tell from the PRs that they were re-treads.
//
// Nothing caught it, because per-file every pin looked fine. The defect only
// exists in the relationship BETWEEN files, which is precisely the thing no
// reviewer reads and no linter looked at.
//
// SHA FAMILIES. Some actions live at distinct paths but must still share a ref.
// `github/codeql-action/init`, `/analyze` and `/upload-sarif` are three separate
// action paths; CodeQL nonetheless aborts the whole run when init and analyze
// come from different versions:
//
//     ##[error]Loaded a configuration file for version '4.38.0',
//              but running version '4.37.9'
//
// So grouping strictly by action path would let that pair drift and report
// green. The families table below normalises such sets into one group.
//
// RUNS ON BARE NODE, BY DESIGN. No dependencies, no `pnpm install`, no build —
// a gate that needs the toolchain it is guarding cannot run when the toolchain
// is what broke.
//
// SELF-TEST. `--self-test` runs the checker against inline fixtures that MUST
// fail and fixtures that MUST pass, then exits non-zero if either expectation
// is violated. CI runs it immediately before the real check, every time. This is
// not ceremony: this gate's whole job is to go red, and a gate only ever
// observed green proves nothing about its ability to do so. Keeping the negative
// case in-tree means it is re-proved on every run rather than once, by hand, by
// whoever wrote it.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const WORKFLOW_DIR = ".github/workflows";

// Sets of distinct action paths that must nonetheless resolve to the same ref.
// `why` is printed in the failure message — a gate should explain itself at the
// moment it fires, not only in the file nobody opens.
export const SHA_FAMILIES = [
  {
    name: "github/codeql-action/*",
    matches: (action) => action.startsWith("github/codeql-action/"),
    why: "CodeQL aborts the run when init and analyze come from different versions",
  },
];

/** Group key for an action path: its family name, else the path itself. */
export function groupKeyFor(action) {
  const family = SHA_FAMILIES.find((f) => f.matches(action));
  return family ? family.name : action;
}

/**
 * Extract action references from one workflow's text.
 *
 * Deliberately a line regex rather than a YAML parse: this must run on bare
 * node with no dependencies, and `uses:` values are single-line by
 * construction. Skips local actions (`./…`) and container actions
 * (`docker://…`) — neither has a ref this gate can compare.
 */
export function parseWorkflow(text, file = "<inline>") {
  const refs = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(
      /^\s*(?:-\s+)?uses:\s*["']?([^"'\s@]+)@([^"'\s#]+)["']?\s*(?:#\s*(.*?))?\s*$/,
    );
    if (!m) continue;
    const [, action, ref, comment] = m;
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    refs.push({
      file,
      line: i + 1,
      action,
      ref,
      version: comment ? comment.trim() : null,
    });
  }
  return refs;
}

/**
 * Two independent assertions over the same parse:
 *
 *   refConflicts     one group resolved to more than one ref  -> the #920 defect
 *   commentConflicts one ref carried more than one version comment
 *
 * The second is not the same check restated. A single SHA described as two
 * different versions means at least one comment is lying, and the comment is the
 * only part of a pin a human actually reads (repo-conform F7 requires it for
 * exactly that reason).
 */
export function findViolations(refs) {
  const groups = new Map();
  for (const r of refs) {
    const key = groupKeyFor(r.action);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const refConflicts = [];
  const commentConflicts = [];

  for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const byRef = new Map();
    for (const m of members) {
      if (!byRef.has(m.ref)) byRef.set(m.ref, []);
      byRef.get(m.ref).push(m);
    }
    if (byRef.size > 1) {
      const family = SHA_FAMILIES.find((f) => f.name === key);
      refConflicts.push({ key, why: family?.why ?? null, byRef });
    }

    for (const [ref, sharing] of byRef) {
      const versions = new Set(sharing.map((m) => m.version).filter(Boolean));
      if (versions.size > 1) commentConflicts.push({ key, ref, sharing, versions });
    }
  }

  return { refConflicts, commentConflicts, groupCount: groups.size, refCount: refs.length };
}

const at = (m) => `${m.file}:${m.line}`;
const short = (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref);

export function formatReport({ refConflicts, commentConflicts }) {
  const out = [];
  for (const { key, why, byRef } of refConflicts) {
    out.push(`${key} resolves to ${byRef.size} different refs:`);
    for (const [ref, members] of byRef) {
      const version = members.find((m) => m.version)?.version;
      out.push(`    ${short(ref)}${version ? `  (${version})` : ""}`);
      for (const m of members) out.push(`        ${at(m)}  ${m.action}`);
    }
    if (why) out.push(`  ^ these must match: ${why}`);
    out.push("");
  }
  for (const { key, ref, sharing, versions } of commentConflicts) {
    out.push(`${key} pin ${short(ref)} is labelled ${[...versions].join(" and ")}:`);
    for (const m of sharing) out.push(`        ${at(m)}  # ${m.version ?? "(no version comment)"}`);
    out.push("  ^ one of these comments is wrong; the comment is the only readable form of a pin");
    out.push("");
  }
  return out.join("\n");
}

function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => parseWorkflow(readFileSync(join(dir, f), "utf8"), `${dir}/${basename(f)}`));
}

// ── self-test ───────────────────────────────────────────────────────────────
// Fixtures are minimal on purpose. Each names the property it pins down, and the
// MUST-FAIL and MUST-PASS sets are both required: without the passing cases a
// checker that flagged everything would look identical to one that works.
const FIXTURES = [
  {
    name: "same action at two SHAs in two files",
    shouldFail: true,
    files: {
      "a.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0",
      "b.yml": "    - uses: actions/checkout@" + "b".repeat(40) + " # v6.0.2",
    },
  },
  {
    name: "same action at two SHAs in ONE file",
    shouldFail: true,
    files: {
      "a.yml":
        "    - uses: actions/setup-node@" + "a".repeat(40) + " # v6.5.0\n" +
        "    - uses: actions/setup-node@" + "c".repeat(40) + " # v6.3.0",
    },
  },
  {
    name: "codeql-action family split across init/analyze — distinct paths, one required SHA",
    shouldFail: true,
    files: {
      "a.yml":
        "        uses: github/codeql-action/init@" + "d".repeat(40) + " # v4.38.0\n" +
        "        uses: github/codeql-action/analyze@" + "e".repeat(40) + " # v4.37.9",
    },
  },
  {
    name: "tag pinned in one place, SHA in another",
    shouldFail: true,
    files: {
      "a.yml": "    - uses: actions/checkout@v6\n",
      "b.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0",
    },
  },
  {
    name: "one SHA labelled with two different versions",
    shouldFail: true,
    files: {
      "a.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0",
      "b.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.0.2",
    },
  },
  {
    name: "consistent pins across several files and actions",
    shouldFail: false,
    files: {
      "a.yml":
        "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0\n" +
        "      uses: actions/setup-node@" + "f".repeat(40) + " # v6.5.0",
      "b.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0",
    },
  },
  {
    name: "whole codeql-action family at one SHA",
    shouldFail: false,
    files: {
      "a.yml":
        "        uses: github/codeql-action/init@" + "d".repeat(40) + " # v4.38.0\n" +
        "        uses: github/codeql-action/analyze@" + "d".repeat(40) + " # v4.38.0",
      "b.yml": "        uses: github/codeql-action/upload-sarif@" + "d".repeat(40) + " # v4.38.0",
    },
  },
  {
    name: "local and container actions are ignored, not compared",
    shouldFail: false,
    files: {
      "a.yml":
        "    - uses: ./.github/actions/setup\n" +
        "    - uses: docker://alpine:3.20\n" +
        "    - uses: docker://alpine:3.21",
    },
  },
  {
    name: "a pin with no version comment is not a comment conflict",
    shouldFail: false,
    files: {
      "a.yml": "    - uses: actions/checkout@" + "a".repeat(40),
      "b.yml": "    - uses: actions/checkout@" + "a".repeat(40) + " # v6.1.0",
    },
  },
];

function selfTest() {
  let bad = 0;
  for (const fx of FIXTURES) {
    const refs = Object.entries(fx.files).flatMap(([f, text]) => parseWorkflow(text, f));
    const v = findViolations(refs);
    const failed = v.refConflicts.length > 0 || v.commentConflicts.length > 0;
    const ok = failed === fx.shouldFail;
    if (!ok) bad++;
    console.log(
      `${ok ? "ok  " : "FAIL"}  expected ${fx.shouldFail ? "RED " : "green"}, got ` +
        `${failed ? "RED " : "green"}  ${fx.name}`,
    );
    if (!ok && failed) console.log(formatReport(v).replace(/^/gm, "        "));
  }
  const red = FIXTURES.filter((f) => f.shouldFail).length;
  console.log(
    `\nself-test: ${FIXTURES.length - bad}/${FIXTURES.length} fixtures behaved as declared ` +
      `(${red} must-fail, ${FIXTURES.length - red} must-pass)`,
  );
  if (bad) {
    console.error(
      `\n${bad} fixture(s) did not behave as declared — the checker itself is broken, ` +
        `so its verdict on the real workflows means nothing.`,
    );
    process.exit(1);
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const refs = readWorkflows(WORKFLOW_DIR);
  const v = findViolations(refs);

  if (v.refConflicts.length === 0 && v.commentConflicts.length === 0) {
    console.log(
      `ok: ${v.refCount} action reference(s) across ${v.groupCount} group(s), ` +
        `each resolving to exactly one ref`,
    );
    return;
  }

  console.error(formatReport(v));
  console.error(
    "An action used in more than one place must resolve to the same ref everywhere.\n" +
      "Fix the outlier rather than the majority: the stale pin is usually the one\n" +
      "hand-copied into a newly added workflow or job (vikunja#920).",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
