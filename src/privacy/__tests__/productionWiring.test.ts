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

  it("buildAgentExecutorDeps supplies the shadow deps too (ADR-0021)", () => {
    // Shadow mode inherits the same failure mode as the enforcing pair above:
    // optional deps nobody supplies look exactly like a feature that was never
    // built. Worse here, because its whole output is a coverage number — an
    // unwired shadow reports "0 observed" and reads as "nothing crossed".
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/(?<![\w$])loadPrivacyShadowConfigFn\s*:/);
    expect(src).toMatch(/(?<![\w$])recordPrivacyShadowFn\s*:/);
  });

  it("shadow reads privacy.shadow, NOT privacy.destinations", () => {
    // Two keys is the safety property, not a naming preference: if shadow read
    // the enforcing config, switching shadow on would switch ENFORCEMENT on,
    // and an operator asking "what would this policy do?" would find out by
    // having it applied to live traffic.
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/privacy\?\.shadow/);
  });

  it("the receipt log is a shared instance, not per call", () => {
    // A per-call instance restarts `seq` at 1 on every dispatch — the same
    // per-instance-counter-on-a-shared-file defect that collided 142 of 145
    // run-log seqs (#1324). The per-directory map is what prevents it.
    //
    // It MOVED to `boundaryReceiptLog.ts` when the orchestrator path gained
    // enforcement: two writers each holding their own map is the very defect
    // above, so the map has to be shared between them and not copied. The
    // guard follows it rather than being deleted — the property being pinned
    // did not change, only its address.
    const src = read("src/privacy/boundaryReceiptLog.ts");
    expect(src).toMatch(/_sharedLogs = new Map/);
    expect(src).toMatch(/function sharedBoundaryReceiptLog\(\)/);
    // And both writers must go through it. A second `new BoundaryReceiptLog`
    // in production code would reintroduce the colliding counter silently.
    for (const f of [
      "src/recipes/yamlRunner.ts",
      "src/claudeOrchestrator.ts",
    ]) {
      expect(read(f), `${f} builds its own receipt log`).not.toMatch(
        /new BoundaryReceiptLog\(/,
      );
      expect(read(f)).toMatch(/sharedBoundaryReceiptLog\(\)/);
    }
  });

  it("reads config per call so an edit takes effect without a restart", () => {
    // Capturing the config at module load would freeze it — the same defect
    // as the frozen OAuth redirect URI (#1266) and the module-level
    // RECIPES_DIR (#1265).
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/(?<![\w$])loadPrivacyConfigFn:\s*\(\)\s*=>/);
  });
});
