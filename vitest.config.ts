import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
      // Floor raised to match the reference gate, 2026-09-07 (vikunja#706).
      // MEASURED: statements 90.47%, branches 85.09%, functions 88.93%,
      // lines 92.53%. Both headline targets now clear: 90 lines and 85
      // branches, which is the gate ihor-sokoliuk/mcp-searxng runs.
      //
      // Reached by adding fast-check property tests over src/ssrf-guard.ts and
      // src/extractors/*, then hand-written branch tests for the paths those
      // could not reach — the CAS write path in cache.ts, the CLI exit codes,
      // withSpan's credential redaction, the NATS publish hooks, and the
      // version-varying SearXNG meta shapes.
      //
      // ON THE MARGINS. The convention this file already carries is a floor
      // ~1.5 points below measured, so ordinary fluctuation does not fail CI.
      // Statements (89 vs 90.47) and functions (87 vs 88.93) follow it.
      // Lines and BRANCHES deliberately do not: they are pinned at the target
      // values, so branches has only 0.09 points — about 2 branches — of
      // headroom. That is a choice, not an oversight. The target is the point
      // of the exercise, and a floor set below it would let the thing just
      // achieved slip away unnoticed, which is exactly how the previous floor
      // rotted (below).
      //
      // If a legitimate change costs you those two branches, cover them or
      // move the floor DELIBERATELY and record the new measurement here. Do
      // not shave it to make a red build green.
      //
      // Coverage is stable run-to-run despite the new property tests: measured
      // four consecutive full runs at exactly 1661/1952 branches. fast-check
      // seeds vary per run, but the generators saturate the same reachable
      // branch set at these run counts. Checked rather than assumed — random
      // input would otherwise be a real source of a flaky gate.
      //
      // Previous floor was 86/84/83/77, measured 2026-09-06 against
      // statements 85.51 / branches 78.54 / functions 84.86 / lines 87.83.
      //
      // The floor before THAT was 72/65/74/74, measured 2026-07-12. It then
      // went ten releases without being touched while real coverage climbed
      // twelve points, so by v3.23.0 the gate permitted a silent twelve-point
      // regression — the comment already said "ratchet up as coverage grows"
      // and nothing did it (vikunja#680).
      //
      // Record the measured numbers with each bump. Without them the next
      // person has no way to tell an intentional floor from a stale one, which
      // is exactly how this drifted.
      thresholds: {
        lines: 90,
        statements: 89,
        functions: 87,
        branches: 85,
      },
    },
  },
});
