import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    setupFiles: ["src/__tests__/testEnvSetup.ts"],
    testTimeout: 15_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        // Pure type-definition files — no runtime code to cover
        "src/**/types.ts",
        // Entry-point bootstrappers — integration-tested elsewhere
        "src/bridge.ts",
        "src/index.ts",
      ],
      all: true,
      // Re-baselined for vitest 4's AST-aware coverage counting (the ast-v8
      // remapper counts more branches than v3's heuristic, so the SAME tests
      // measure lower — branches especially). Was 75/70/75 under vitest 3.
      // Actual coverage did not regress; only the measurement got stricter.
      thresholds: {
        lines: 72,
        branches: 63,
        functions: 71,
      },
    },
  },
});
