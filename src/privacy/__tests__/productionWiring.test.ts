import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The boundary must be WIRED, not merely implemented.
 *
 * `loadPrivacyConfigFn` and `recordBoundaryDecisionFn` are optional deps on
 * `AgentExecutorDeps`. Optional deps that no production caller supplies are
 * indistinguishable, at runtime, from a feature that was never built: the
 * decision function is correct, its tests pass, and every real dispatch skips
 * it because the config never arrives.
 *
 * This is a SOURCE-level assertion on purpose. A behavioural test would need to
 * drive a whole recipe run, and the failure it guards against is precisely that
 * a wiring line goes missing — which greps reliably and mocks do not.
 */
const ROOT = path.join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("the information boundary is wired into production dispatch", () => {
  it("buildAgentExecutorDeps supplies loadPrivacyConfigFn", () => {
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/(?<![\w$])loadPrivacyConfigFn\s*:/);
  });

  it("buildAgentExecutorDeps supplies recordBoundaryDecisionFn", () => {
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/(?<![\w$])recordBoundaryDecisionFn\s*:/);
  });

  it("the receipt log is a shared instance, not per call", () => {
    // A per-call instance restarts `seq` at 1 on every dispatch — the same
    // per-instance-counter-on-a-shared-file defect that collided 142 of 145
    // run-log seqs (#1324). The lazy singleton is what prevents it.
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/_boundaryReceiptLogs = new Map/);
    expect(src).toMatch(/function boundaryReceiptLog\(\)/);
  });

  it("reads config per call so an edit takes effect without a restart", () => {
    // Capturing the config at module load would freeze it — the same defect
    // as the frozen OAuth redirect URI (#1266) and the module-level
    // RECIPES_DIR (#1265).
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/(?<![\w$])loadPrivacyConfigFn:\s*\(\)\s*=>/);
  });
});
