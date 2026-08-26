/**
 * A chained recipe's run-level `expect:` used to be dropped in silence.
 *
 * `dispatchRecipe` casts a `YamlRecipe` straight to a `ChainedRecipe`, so the
 * block was present on the object at runtime — but `ChainedRecipe` had no
 * `expect` field and `runChainedRecipe` never evaluated one. Reproduced
 * against a real run before the fix: two impossible assertions
 * (`stepsRun: 99`, an output key nothing produces), `status: done`, and no
 * `assertionFailures` anywhere. `recipe lint` reported zero warnings.
 *
 * That is the "lints clean, never fires" family, and it is why these tests
 * assert on the run-log row and not only on the returned object: the value
 * being right while nothing persists it is the same defect one layer along.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";

const deps: ExecutionDeps = {
  executeTool: vi.fn().mockResolvedValue({ ok: true }),
  executeAgent: vi.fn().mockResolvedValue("agent output"),
  loadNestedRecipe: vi.fn().mockResolvedValue(null),
};

const baseOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};

function recipe(over: Partial<ChainedRecipe> = {}): ChainedRecipe {
  return {
    name: "chained-contract",
    steps: [{ id: "fetch", tool: "http.get" }],
    ...over,
  };
}

/** Minimal run-log double — records what `completeRun` was handed. */
function fakeRunLog() {
  const completed: Array<Record<string, unknown>> = [];
  return {
    completed,
    log: {
      startRun: () => 1,
      completeRun: (_seq: number, patch: Record<string, unknown>) => {
        completed.push(patch);
      },
    } as unknown as NonNullable<RunOptions["runLog"]>,
  };
}

describe("chained run-level expect", () => {
  it("evaluates a contract that the run cannot satisfy", async () => {
    const result = await runChainedRecipe(
      recipe({ expect: { stepsRun: 99, outputs: ["never-produced"] } }),
      baseOptions,
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.assertionFailures).toHaveLength(2);
  });

  it("reports, it does not roll back — success stays true", async () => {
    const result = await runChainedRecipe(
      recipe({ expect: { outputs: ["never-produced"] } }),
      baseOptions,
      deps,
    );
    // Same posture as the flat runner: a violated postcondition is recorded,
    // the run still completed and its side effects still happened.
    expect(result.success).toBe(true);
    expect(result.errorMessage).toBeUndefined();
    expect(result.assertionFailures).toHaveLength(1);
  });

  it("a satisfied contract records NOTHING, not an empty array", async () => {
    // "No contract" and "the contract passed" must stay distinguishable.
    const result = await runChainedRecipe(
      recipe({ expect: { stepsRun: 1, outputs: ["fetch"] } }),
      baseOptions,
      deps,
    );
    expect(result.assertionFailures).toBeUndefined();
  });

  it("a recipe with no contract records nothing", async () => {
    const result = await runChainedRecipe(recipe(), baseOptions, deps);
    expect(result.assertionFailures).toBeUndefined();
  });

  /**
   * `outputs` is keyed by STEP ID here, and by agent `into:` keys / resolved
   * file paths on the flat runner. Deliberate, and asserted so nobody
   * "harmonises" one side without noticing the other.
   */
  it("outputs are step ids, and a flat-style entry fails loudly", async () => {
    const ok = await runChainedRecipe(
      recipe({ expect: { outputs: ["fetch"] } }),
      baseOptions,
      deps,
    );
    expect(ok.assertionFailures).toBeUndefined();

    const flatStyle = await runChainedRecipe(
      recipe({ expect: { outputs: ["/abs/path/out.md"] } }),
      baseOptions,
      deps,
    );
    expect(flatStyle.assertionFailures).toHaveLength(1);
  });

  it("persists the failures onto the run-log row", async () => {
    const { completed, log } = fakeRunLog();
    await runChainedRecipe(
      recipe({ expect: { outputs: ["never-produced"] } }),
      { ...baseOptions, runLog: log },
      deps,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.assertionFailures).toHaveLength(1);
    // The run is still `done` on the row too — the halt count is what surfaces
    // the violation, not the status.
    expect(completed[0]?.status).toBe("done");
  });

  it("omits the field on the row when the contract held", async () => {
    const { completed, log } = fakeRunLog();
    await runChainedRecipe(
      recipe({ expect: { outputs: ["fetch"] } }),
      { ...baseOptions, runLog: log },
      deps,
    );
    expect(completed[0]).not.toHaveProperty("assertionFailures");
  });

  it("a throwing contract cannot strand the run", async () => {
    const result = await runChainedRecipe(
      // A non-object expect is the shape most likely to blow up the helper.
      recipe({ expect: null as unknown as ChainedRecipe["expect"] }),
      baseOptions,
      deps,
    );
    expect(result.success).toBe(true);
  });
});
