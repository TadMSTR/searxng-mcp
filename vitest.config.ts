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
      // Floor set from the measured baseline (2026-09-06, consolidated fix
      // pass), not a guessed target: statements 85.51%, branches 78.54%,
      // functions 84.86%, lines 87.83%. Roughly 1.5 points below each, so
      // normal fluctuation does not fail CI.
      //
      // Previous floor was 72/65/74/74, measured 2026-07-12 against
      // statements 73.28 / branches 66.06 / functions 75.17 / lines 75.32.
      // It then went ten releases without being touched while real coverage
      // climbed twelve points, so by v3.23.0 the gate permitted a silent
      // twelve-point regression — the comment already said "ratchet up as
      // coverage grows" and nothing did it (vikunja#680).
      //
      // Record the measured numbers with each bump. Without them the next
      // person has no way to tell an intentional floor from a stale one, which
      // is exactly how this drifted.
      thresholds: {
        lines: 86,
        statements: 84,
        functions: 83,
        branches: 77,
      },
    },
  },
});
