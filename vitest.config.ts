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
      // Floor set from the measured post-Phase-3 baseline (2026-07-11), not a
      // guessed target: statements 70.54%, branches 64.09%, functions 73.52%,
      // lines 72.66%. Small margin below each so normal fluctuation doesn't
      // fail CI; ratchet up as coverage grows.
      thresholds: {
        lines: 72,
        statements: 70,
        functions: 73,
        branches: 63,
      },
    },
  },
});
