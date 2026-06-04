import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    setupFiles: ["src/__tests__/testEnvSetup.ts"],
    testTimeout: 15_000,
    hookTimeout: 10_000,
    // Retry only in CI: the bridge suite has timing/IO/port/fs.watch tests that
    // run on shared, overloaded runners (worst on Windows under --coverage), so
    // a genuinely-correct test can fail once on event-loop drift. Up to 3
    // attempts ends the "re-run the whole job by hand" tax without masking real
    // breaks — a true failure still fails all attempts. Local dev keeps retry 0
    // so flakes surface and get fixed (e.g. the pong-starvation timing fix in
    // this same change).
    retry: process.env.CI ? 2 : 0,
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
      // remapper counts more branches/functions than v3's heuristic, so the
      // SAME tests measure lower). Was 75/70/75 under vitest 3. Set ~1pt below
      // the lower of the two CI platforms (Windows: 72.08/63.03/70.94; ubuntu:
      // 72.81/63.55/71.38) so both clear with margin. Coverage did not regress;
      // only the measurement got stricter.
      thresholds: {
        lines: 71,
        branches: 62,
        functions: 70,
      },
    },
  },
});
