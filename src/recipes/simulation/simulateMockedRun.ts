/**
 * What-If Preview (P2) — trace-seeded mocked sandbox.
 *
 * Drives the EXISTING chained runner with a history-backed `mockedOutputs`
 * map + fully-stubbed `ExecutionDeps`, so downstream templates and `when:`
 * branches resolve realistically — while executing NOTHING for real.
 *
 * ★ ZERO real I/O + ZERO persistence is the non-negotiable safety invariant ★
 *   - `STUB_DEPS.executeTool` / `executeAgent` return synthesized placeholders
 *     and never touch a real tool / connector / LLM / fs.
 *   - `loadNestedRecipe` returns null (no nested-recipe execution).
 *   - NO `runLog`, NO `runLogDir`, NO `activityLog` are passed to
 *     `runChainedRecipe`, so nothing is persisted.
 *   - `dryRun:false` (we WANT template/condition resolution), with
 *     `mockedOutputs` covering history-backed steps; any uncovered step falls
 *     through to the STUB deps — still no real execution.
 *
 * Fail-soft: any error is caught and we return what we have; this never throws
 * out to the caller (the static report is always the safe fallback upstream).
 */

import type { RecipeRunLog } from "../../runLog.js";
import type { ChainedRecipe, ExecutionDeps } from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import { synthesizeMockedOutputs } from "./synthesizeMockedOutputs.js";

/**
 * Stub execution deps. Returns deterministic synthesized placeholders and
 * performs no real I/O. Exported so tests can spy on the same shape; callers
 * normally pass the default created in `simulateMockedRun`.
 */
export function createStubDeps(): ExecutionDeps {
  return {
    executeTool: async (tool: string) => `[simulated:${tool}]`,
    executeAgent: async (_prompt: string) => ({
      text: "[simulated:agent]",
    }),
    loadNestedRecipe: async () => null,
  };
}

export interface MockedStepState {
  ran: boolean;
  skipped: boolean;
  mockedFrom: "history" | "synthesized";
}

export interface MockedRunResult {
  /** Per-step id → ran/skipped + whether its value came from history. */
  stepData: Map<string, MockedStepState>;
  /** Step ids that got a real historical value. */
  historyStepIds: Set<string>;
  /** Number of prior runs sampled. */
  sampleRuns: number;
}

/**
 * Run the mocked sandbox for `recipe`, seeded from `runLog` history.
 */
export async function simulateMockedRun(
  recipe: ChainedRecipe,
  runLog: RecipeRunLog,
  opts: { maxRuns?: number } = {},
  /**
   * Test seam — override the stub deps to spy that uncovered steps hit the
   * stub (and never real execution). Defaults to `createStubDeps()`.
   */
  deps: ExecutionDeps = createStubDeps(),
): Promise<MockedRunResult> {
  const { outputs, historyStepIds, sampleRuns } = synthesizeMockedOutputs(
    recipe.name,
    runLog,
    opts,
  );

  const stepData = new Map<string, MockedStepState>();

  try {
    const result = await runChainedRecipe(
      recipe,
      {
        env: { ...process.env } as Record<string, string | undefined>,
        maxConcurrency: Math.max(1, recipe.maxConcurrency ?? 4),
        maxDepth: recipe.maxDepth ?? 3,
        dryRun: false,
        mockedOutputs: outputs,
        // NO runLog / runLogDir / activityLog — nothing is persisted.
      },
      deps,
    );

    for (const [id, stepResult] of result.stepResults) {
      const skipped = stepResult.skipped === true;
      stepData.set(id, {
        ran: !skipped,
        skipped,
        mockedFrom: historyStepIds.has(id) ? "history" : "synthesized",
      });
    }
  } catch {
    // Fail-soft: return whatever we have (possibly empty stepData). The
    // caller falls back to the static report shape.
  }

  return { stepData, historyStepIds, sampleRuns };
}
