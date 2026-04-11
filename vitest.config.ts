import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
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
      thresholds: {
        lines: 75,
        branches: 70,
        functions: 75,
      },
    },
  },
});
