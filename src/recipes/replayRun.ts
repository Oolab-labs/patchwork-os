/**
 * replayRun — VD-4 mocked replay entrypoint.
 *
 * Given an original `RecipeRun` (looked up from `RecipeRunLog`), build a
 * `mockedOutputs` map from each step's captured `output` (VD-2) and
 * re-run the recipe through the matching runner with every tool/agent
 * execution short-circuited to those captured values.
 *
 * Evidence-only, by construction rather than by documentation. Until
 * 2026-09-24 the header here promised "no external network calls, no
 * write side effects" while any step WITHOUT a usable capture (missing
 * `output`, a >8 KB truncation envelope, or a flat step with no `into:`)
 * silently fell through to REAL execution — a real `http.post` went out
 * and a deleted `file.write` target was recreated, with the list of
 * unmocked steps reported only after the run. The invariant now enforced
 * (see `replayBoundary.ts`):
 *
 *   Missing replay evidence REDUCES what can be replayed; it never
 *   increases permission to execute.
 *
 *   1. Preflight: if any step lacks a usable capture the replay is REFUSED
 *      before a run starts, with `replay_refused_unmocked_step` naming
 *      every such step.
 *   2. The run itself is started with `replayOnly: true`, so a step the
 *      preflight somehow missed is refused inside the runner instead of
 *      dispatched, and the dispatch seam (`executeStep` /
 *      `buildAgentExecutorDeps`) throws before any tool or agent is
 *      invoked. A replay's deps are structurally incapable of live
 *      dispatch.
 *   3. After the run, any step carrying a boundary refusal forces
 *      `ok: false` — earlier mocked progress never reads as an unqualified
 *      success.
 *
 * The new run is logged with `triggerSource: "replay:<originalSeq>"` /
 * `manualRunId: "replay-<originalSeq>"` so the audit trail is clear.
 *
 * Real-mode replay (write tools really fire) is deliberately NOT in this
 * module, and there is no "continue live" fallback here either. It needs
 * a confirmation UX, a kill-switch interaction, and possibly a
 * connector-level read/write split. Ship separately after explicit user
 * approval.
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
import { isReplayRefusal, replayRefusalMessage } from "./replayBoundary.js";
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
  /**
   * Steps that lacked a usable captured output. When present the replay
   * was REFUSED (`ok: false`, `error` starts with
   * `replay_refused_unmocked_step`) and no run was started — those steps
   * are never executed live.
   */
  unmockedSteps?: string[];
}

/**
 * Build the `mockedOutputs` map. Truncated captures (>8 KB envelope from
 * VD-2's `captureForRunlog`) are excluded — replaying with a `[truncated]`
 * preview would be misleading. Steps without captures are excluded too.
 *
 * `null`, `""`, `0` and `false` are VALID captures (the tool really
 * returned that) and are kept; only `undefined` means "nothing captured".
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
    if (isTruncatedCapture(out)) {
      unmocked.push(step.id);
      continue;
    }
    outputs.set(step.id, out);
  }
  return { outputs, unmocked };
}

function isTruncatedCapture(out: unknown): boolean {
  return (
    out !== null &&
    typeof out === "object" &&
    (out as Record<string, unknown>)["[truncated]"] === true
  );
}

/**
 * Step ids in a finished run's `stepResults` whose error came from the
 * replay boundary — a refusal the preflight did not pre-empt. Any such
 * step disqualifies the run from reporting as a successful replay, even
 * when the recipe's fail-open settings let the run complete.
 */
function refusedStepIds(
  stepResults: Iterable<{ id?: string; error?: string | Error }> | undefined,
): string[] {
  const ids: string[] = [];
  for (const s of stepResults ?? []) {
    if (s.error !== undefined && isReplayRefusal(s.error)) {
      ids.push(s.id ?? "?");
    }
  }
  return ids;
}

/**
 * Fire a mocked replay of `originalRun` against `recipe`. The recipe
 * argument is supplied by the caller (typically loaded fresh from disk
 * by name) so an EDITED recipe can be replayed against captured
 * outputs — that's the debugging value of replay.
 *
 * Refuses (no run started) when any step lacks a usable capture.
 */
export async function replayMockedRun(opts: {
  originalRun: RecipeRun;
  recipe: ChainedRecipe;
  sourcePath?: string;
  deps: ReplayDeps;
}): Promise<ReplayResult> {
  const { originalRun, recipe, sourcePath, deps } = opts;
  const { outputs, unmocked } = buildMockedOutputs(originalRun);

  // Layer 1 — preflight. Explanatory: names every unmockable step at once.
  if (unmocked.length > 0) {
    return {
      ok: false,
      error: replayRefusalMessage(unmocked),
      unmockedSteps: unmocked,
    };
  }

  const chainedDeps: ExecutionDeps = buildChainedDeps(
    // Layer 3 — the deps a replay hands the runner cannot reach a live tool
    // or agent: `replayOnly` rides on StepDeps into `executeStep` and
    // `buildAgentExecutorDeps`, which throw `ReplayIncompleteError`.
    { ...deps.runnerDeps, replayOnly: true },
    deps.runnerDeps.claudeCodeFn ??
      (async () => {
        return "";
      }),
    recipe.name,
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
    // Layer 2 — a step the preflight missed (e.g. one the edited recipe
    // added) is refused in the runner's step loop, never dispatched.
    replayOnly: true,
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
    const refused = refusedStepIds(
      [...result.stepResults].map(([id, r]) => ({ id, error: r.error })),
    );
    const ok = result.success && refused.length === 0;
    const error =
      refused.length > 0 ? replayRefusalMessage(refused) : result.errorMessage;
    return {
      ok,
      ...(newRun?.seq !== undefined && { newSeq: newRun.seq }),
      result,
      ...(error !== undefined && { error }),
      ...(refused.length > 0 && { unmockedSteps: refused }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Auto-generated positional step id (yamlRunner.ts: `step.into ?? "step_${n}"`).
 * Matched only when the step has no explicit `into:` name — a purely
 * positional id ("step_3" = "the 4th step in THIS run's execution order")
 * that is NOT stable across a recipe edit that adds/removes/reorders
 * steps before it. Replaying against a captured output under a
 * positional id risks silently matching it to a DIFFERENT step after an
 * edit; an explicit `into:` name is a stable, user-chosen identifier
 * (the flat-recipe analogue of a chained recipe's mandatory `id:`) and is
 * safe to replay against. A positional step is therefore NOT mockable —
 * and, since 2026-09-24, not executable under replay either: the replay
 * is refused, naming the step. (The dashboard's `previewMockedReplay`
 * in `registryDiff.ts` applies the same rule, reason `positional-id`.)
 */
const POSITIONAL_STEP_ID = /^step_\d+$/;

/**
 * Build the `mockedOutputs` map for a FLAT (non-chained) recipe's replay.
 * Flat `RunContext` values are strings (see `RunContext = Record<string,
 * string>` in yamlRunner.ts), so a captured non-string output is
 * JSON-stringified — matching what the original tool call's raw string
 * result would have looked like before any downstream `{{template}}`
 * substitution treated it as text.
 *
 * A captured `""` is a valid (empty) result and is kept; a captured
 * `null` becomes the runner's `null` result via `?? null` at the mocked
 * short-circuit. Only `undefined` means "nothing captured".
 */
export function buildFlatMockedOutputs(originalRun: RecipeRun): {
  outputs: Map<string, string>;
  unmocked: string[];
} {
  const outputs = new Map<string, string>();
  const unmocked: string[] = [];
  for (const step of originalRun.stepResults ?? []) {
    if (step.status === "skipped") continue;
    // See POSITIONAL_STEP_ID's doc comment — a step with no explicit
    // `into:` isn't safely replayable against a (possibly edited) recipe
    // file, so the replay is refused rather than the step run live.
    if (POSITIONAL_STEP_ID.test(step.id)) {
      unmocked.push(step.id);
      continue;
    }
    const out = step.output;
    if (out === undefined) {
      unmocked.push(step.id);
      continue;
    }
    if (isTruncatedCapture(out)) {
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
  /** See `ReplayResult.unmockedSteps` — present only on a refusal. */
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
 *
 * Refuses (no run started) when any step lacks a usable capture. Note
 * that flat AGENT steps capture no `output`, so a flat recipe with an
 * agent step is not replayable today — refused, never run live.
 */
export async function replayFlatMockedRun(opts: {
  originalRun: RecipeRun;
  recipe: YamlRecipe;
  deps: ReplayDeps;
}): Promise<FlatReplayResult> {
  const { originalRun, recipe, deps } = opts;
  const { outputs, unmocked } = buildFlatMockedOutputs(originalRun);

  // Layer 1 — preflight.
  if (unmocked.length > 0) {
    return {
      ok: false,
      error: replayRefusalMessage(unmocked),
      unmockedSteps: unmocked,
    };
  }

  try {
    const result = await runYamlRecipe(recipe, {
      ...deps.runnerDeps,
      runLog: deps.runLog,
      ...(deps.activityLog !== undefined && { activityLog: deps.activityLog }),
      mockedOutputs: outputs,
      // Layers 2 + 3 — refused in the step loop, and the StepDeps built from
      // these RunnerDeps throw at the dispatch seam.
      replayOnly: true,
      manualRunId: `replay-${originalRun.seq}`,
      testMode: false,
    });
    const recent = deps.runLog.query({ recipe: recipe.name, limit: 5 });
    const newRun = recent.find((r) => r.createdAt >= originalRun.doneAt);
    const refused = refusedStepIds(result.stepResults);
    const ok = !result.errorMessage && refused.length === 0;
    const error =
      refused.length > 0 ? replayRefusalMessage(refused) : result.errorMessage;
    return {
      ok,
      ...(newRun?.seq !== undefined && { newSeq: newRun.seq }),
      result,
      ...(error !== undefined && { error }),
      ...(refused.length > 0 && { unmockedSteps: refused }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
