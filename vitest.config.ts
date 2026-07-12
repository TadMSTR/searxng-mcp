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
      // Floor set from the measured baseline (2026-07-12, domain-stats build),
      // not a guessed target: statements 73.28%, branches 66.06%, functions
      // 75.17%, lines 75.32%. Small margin below each so normal fluctuation
      // doesn't fail CI; ratchet up as coverage grows.
      thresholds: {
        lines: 74,
        statements: 72,
        functions: 74,
        branches: 65,
      },
    },
  },
});
