/**
 * replayRun — VD-4 mocked replay entrypoint.
 *
 * Given an original `RecipeRun` (looked up from `RecipeRunLog`), build a
 * `mockedOutputs` map from each step's captured `output` (VD-2) and
 * re-run the recipe through `runChainedRecipe` with all tool/agent
 * execution short-circuited to those captured values.
 *
 * Pure mocked-only: no external network calls, no write side effects.
 * The new run is logged with `triggerSource: "replay:<originalSeq>"`
 * so the audit trail is clear.
 *
 * Real-mode replay (write tools really fire) is deliberately NOT in
 * this module. It needs a confirmation UX, a kill-switch interaction,
 * and possibly a connector-level read/write split. Ship separately
 * after explicit user approval.
 */

import type { ActivityLog } from "../activityLog.js";
import type { RecipeRun, RecipeRunLog } from "../runLog.js";
import type {
  ChainedRecipe,
  ChainedRunResult,
  ExecutionDeps,
  RunOptions,
} from "./chainedRunner.js";
import { runChainedRecipe } from "./chainedRunner.js";
import type { RunnerDeps, RunResult, YamlRecipe } from "./yamlRunner.js";
import {
  buildChainedDeps,
  declaredRecipeEnv,
  runYamlRecipe,
} from "./yamlRunner.js";

export interface ReplayDeps {
  /** Long-lived run log so the new run shows up live in the dashboard. */
  runLog: RecipeRunLog;
  /** Activity log for live-tail SSE on the new run. Optional. */
  activityLog?: ActivityLog;
  /** Workdir + claudeCodeFn etc., reused from the orchestrator. */
  runnerDeps: RunnerDeps;
}

export interface ReplayResult {
  ok: boolean;
  /** New run's seq if the replay started successfully. */
  newSeq?: number;
  /** Underlying recipe-run result for callers that want full detail. */
  result?: ChainedRunResult;
  error?: string;
  /** Steps that lacked captured outputs and were dropped from the
   *  mocked map. The replay still runs but those steps fall through to
   *  REAL execution — callers may want to surface this as a warning. */
  unmockedSteps?: string[];
}

/**
 * Build the `mockedOutputs` map. Truncated captures (>8 KB envelope from
 * VD-2's `captureForRunlog`) are excluded — replaying with a `[truncated]`
 * preview would be misleading. Steps without captures are excluded too.
 */
export function buildMockedOutputs(originalRun: RecipeRun): {
  outputs: Map<string, unknown>;
  unmocked: string[];
} {
  const outputs = new Map<string, unknown>();
  const unmocked: string[] = [];
  for (const step of originalRun.stepResults ?? []) {
    if (step.status === "skipped") continue;
    const out = step.output;
    if (out === undefined) {
      unmocked.push(step.id);
      continue;
    }
    // Skip the truncation envelope — replaying with a preview slice
    // would be misleading.
    if (
      out !== null &&
      typeof out === "object" &&
      (out as Record<string, unknown>)["[truncated]"] === true
    ) {
      unmocked.push(step.id);
      continue;
    }
    outputs.set(step.id, out);
  }
  return { outputs, unmocked };
}

/**
 * Fire a mocked replay of `originalRun` against `recipe`. The recipe
 * argument is supplied by the caller (typically loaded fresh from disk
 * by name) so an EDITED recipe can be replayed against captured
 * outputs — that's the debugging value of replay.
 */
export async function replayMockedRun(opts: {
  originalRun: RecipeRun;
  recipe: ChainedRecipe;
  sourcePath?: string;
  deps: ReplayDeps;
}): Promise<ReplayResult> {
  const { originalRun, recipe, sourcePath, deps } = opts;
  const { outputs, unmocked } = buildMockedOutputs(originalRun);

  const chainedDeps: ExecutionDeps = buildChainedDeps(
    deps.runnerDeps,
    deps.runnerDeps.claudeCodeFn ??
      (async () => {
        return "";
      }),
  );

  const runOptions: RunOptions = {
    // Audit 2026-06-08 (recipe-support-3): replay must enforce the same
    // declared-keys env allowlist as the live chained/flat paths — never spread
    // the full process.env into the template context.
    env: { ...declaredRecipeEnv(recipe) } as Record<string, string | undefined>,
    maxConcurrency: Math.max(1, recipe.maxConcurrency ?? 4),
    maxDepth: recipe.maxDepth ?? 3,
    dryRun: false,
    ...(sourcePath !== undefined && { sourcePath }),
    runLog: deps.runLog,
    ...(deps.activityLog !== undefined && { activityLog: deps.activityLog }),
    mockedOutputs: outputs,
    // BUG-4 fix: tag the new run's taskId so it's distinguishable from a
    // fresh run. Searchable as `taskId LIKE 'replay:<seq>:%'`.
    taskIdPrefix: `replay:${originalRun.seq}`,
  };

  try {
    const result = await runChainedRecipe(recipe, runOptions, chainedDeps);
    // The runner's completeRun path will have already written the new
    // run to the log. Find its seq — most-recent matching recipeName,
    // started after originalRun.doneAt.
    const recent = deps.runLog.query({ recipe: recipe.name, limit: 5 });
    const newRun = recent.find((r) => r.createdAt > originalRun.doneAt);
    return {
      ok: result.success,
      ...(newRun?.seq !== undefined && { newSeq: newRun.seq }),
      result,
      ...(result.errorMessage !== undefined && { error: result.errorMessage }),
      ...(unmocked.length > 0 && { unmockedSteps: unmocked }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(unmocked.length > 0 && { unmockedSteps: unmocked }),
    };
  }
}

/**
 * Build the `mockedOutputs` map for a FLAT (non-chained) recipe's replay.
 * Flat `RunContext` values are strings (see `RunContext = Record<string,
 * string>` in yamlRunner.ts), so a captured non-string output is
 * JSON-stringified — matching what the original tool call's raw string
 * result would have looked like before any downstream `{{template}}`
 * substitution treated it as text.
 */
export function buildFlatMockedOutputs(originalRun: RecipeRun): {
  outputs: Map<string, string>;
  unmocked: string[];
} {
  const outputs = new Map<string, string>();
  const unmocked: string[] = [];
  for (const step of originalRun.stepResults ?? []) {
    if (step.status === "skipped") continue;
    const out = step.output;
    if (out === undefined) {
      unmocked.push(step.id);
      continue;
    }
    if (
      out !== null &&
      typeof out === "object" &&
      (out as Record<string, unknown>)["[truncated]"] === true
    ) {
      unmocked.push(step.id);
      continue;
    }
    outputs.set(step.id, typeof out === "string" ? out : JSON.stringify(out));
  }
  return { outputs, unmocked };
}

export interface FlatReplayResult {
  ok: boolean;
  /** New run's seq if the replay started successfully. */
  newSeq?: number;
  /** Underlying flat-runner result for callers that want full detail. */
  result?: RunResult;
  error?: string;
  /** Steps that lacked captured outputs — fell through to REAL execution. */
  unmockedSteps?: string[];
}

/**
 * Fire a mocked replay of a FLAT (manual/cron/webhook-triggered) recipe's
 * run — the counterpart to `replayMockedRun` for recipes that use
 * `runYamlRecipe` rather than `runChainedRecipe`. Previously flat recipes
 * had NO replay capability at all (`runReplayFn` in recipeOrchestration.ts
 * hard-coded `replay_only_supported_for_chained_recipes`) even though
 * `runYamlRecipe`'s per-step captures (added alongside this function) make
 * it just as replayable.
 *
 * Tagged via `manualRunId: "replay-<originalSeq>"` (reusing the existing
 * PR5b field) rather than a taskId prefix — yamlRunner's taskId format
 * (`yaml:<recipe>:<startedAt>`) has no override seam, and manualRunId is
 * already surfaced in the dashboard / `runs.jsonl`, so this is enough to
 * distinguish a replay run from a real one without new plumbing.
 */
export async function replayFlatMockedRun(opts: {
  originalRun: RecipeRun;
  recipe: YamlRecipe;
  deps: ReplayDeps;
}): Promise<FlatReplayResult> {
  const { originalRun, recipe, deps } = opts;
  const { outputs, unmocked } = buildFlatMockedOutputs(originalRun);

  try {
    const result = await runYamlRecipe(recipe, {
      ...deps.runnerDeps,
      runLog: deps.runLog,
      ...(deps.activityLog !== undefined && { activityLog: deps.activityLog }),
      mockedOutputs: outputs,
      manualRunId: `replay-${originalRun.seq}`,
      testMode: false,
    });
    const recent = deps.runLog.query({ recipe: recipe.name, limit: 5 });
    const newRun = recent.find((r) => r.createdAt >= originalRun.doneAt);
    return {
      ok: !result.errorMessage,
      ...(newRun?.seq !== undefined && { newSeq: newRun.seq }),
      result,
      ...(result.errorMessage !== undefined && { error: result.errorMessage }),
      ...(unmocked.length > 0 && { unmockedSteps: unmocked }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(unmocked.length > 0 && { unmockedSteps: unmocked }),
    };
  }
}
