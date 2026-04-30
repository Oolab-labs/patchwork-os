/**
 * ChainedRecipeRunner — executes recipes with:
 *   - Parallel step execution (respecting dependencies)
 *   - Template-based variable resolution
 *   - Nested recipe calls
 *   - Conditional step execution (when)
 *   - Dry-run mode
 */

import { captureForRunlog } from "./captureForRunlog.js";
import type { ExecutionOptions, StepExecutor } from "./dependencyGraph.js";
import {
  buildDependencyGraph,
  executeWithDependencies,
} from "./dependencyGraph.js";
import type {
  NestedRecipeConfig,
  NestedRecipeContext,
} from "./nestedRecipeStep.js";
import {
  mockNestedRecipe,
  resolveNestedVars,
  validateNestedRecipe,
} from "./nestedRecipeStep.js";
import type { OutputRegistry } from "./outputRegistry.js";
import { createOutputRegistry } from "./outputRegistry.js";
import type { ErrorPolicy } from "./schema.js";
import type { TemplateContext, TemplateError } from "./templateEngine.js";
import { compileTemplate } from "./templateEngine.js";

export interface ChainedStep {
  id: string;
  tool?: string;
  agent?: { prompt: string; model?: string; driver?: string };
  recipe?: NestedRecipeConfig["recipe"];
  chain?: NestedRecipeConfig["recipe"];
  /** Sugar: run these steps concurrently. Expanded to flat steps at runtime. */
  parallel?: ChainedStep[];
  vars?: Record<string, string>;
  awaits?: string[];
  when?: string; // template condition
  output?: string; // alias for into
  risk?: "low" | "medium" | "high";
  optional?: boolean;
  /** Retry count for this step on failure (overrides recipe-level on_error.retry). */
  retry?: number;
  /** Delay in ms between retries (default 1000). */
  retryDelay?: number;
  transform?: string; // template rendered after tool execution; $result = raw tool output
  [key: string]: unknown;
}

export interface ChainedRecipe {
  name: string;
  description?: string;
  steps: ChainedStep[];
  maxConcurrency?: number;
  maxDepth?: number;
  /** Plugin specs (npm package name or local path) to load before running steps. */
  servers?: string[];
  on_error?: ErrorPolicy;
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  maxConcurrency: number;
  maxDepth: number;
  dryRun: boolean;
  sourcePath?: string;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, error?: Error) => void;
  /**
   * Directory holding `runs.jsonl`. When set (and `runLog` is not), the
   * runner constructs a local `RecipeRunLog` and uses `appendDirect` at the
   * end. Use for CLI invocations where there's no long-lived log instance.
   */
  runLogDir?: string;
  /**
   * Long-lived `RecipeRunLog` instance. When set, the runner uses
   * `startRun` + `completeRun` so the dashboard sees the run as `"running"`
   * while it's in flight. Bridge-driven recipes pass this; CLI runs don't.
   * Takes precedence over `runLogDir`.
   */
  runLog?: import("../runLog.js").RecipeRunLog;
  /**
   * Bridge `ActivityLog` for VD-1 live-tail. When set together with
   * `runLog`, the runner broadcasts `recipe_step_start` and
   * `recipe_step_done` lifecycle events tagged with `runSeq` so the
   * dashboard `/runs/[seq]` page can subscribe via SSE instead of polling.
   */
  activityLog?: import("../activityLog.js").ActivityLog;
  /**
   * VD-4 mocked replay: when set, the runner intercepts tool/agent
   * execution and returns the captured output for each step from this
   * map instead of calling the real executor. Pure-mocked: no external
   * IO, no side effects. Used by `POST /runs/:seq/replay`.
   *
   * If a step's id is NOT in the map, the runner falls through to real
   * execution — callers wanting strict mocked-only mode pre-populate
   * every step the recipe will visit.
   */
  mockedOutputs?: Map<string, unknown>;
  /**
   * Override the prefix used in the run log's `taskId`. Default is
   * `chained` → `chained:<recipeName>:<startTs>`. Replay sets this to
   * `replay:<originalSeq>` so the audit trail is searchable
   * (`taskId LIKE 'replay:%'`) — fixes BUG-4 from the post-merge
   * dogfood where replay runs were indistinguishable from fresh ones.
   */
  taskIdPrefix?: string;
}

export interface StepExecutionContext {
  registry: OutputRegistry;
  step: ChainedStep;
  options: RunOptions;
  recipe: ChainedRecipe;
  depth: number;
}

export type ToolExecutor = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export type AgentExecutor = (
  prompt: string,
  model?: string,
  driver?: string,
) => Promise<string>;

export interface ExecutionDeps {
  executeTool: ToolExecutor;
  executeAgent: AgentExecutor;
  loadNestedRecipe: (
    name: string,
    parentSourcePath?: string,
  ) => Promise<{ recipe: ChainedRecipe; sourcePath?: string } | null>;
}

function nestedRecipeRef(step: ChainedStep): string | undefined {
  return typeof step.recipe === "string"
    ? step.recipe
    : typeof step.chain === "string"
      ? step.chain
      : undefined;
}

/** Build template context from registry and env */
export function buildTemplateContext(
  registry: OutputRegistry,
  env: Record<string, string | undefined>,
): TemplateContext {
  return registry.toTemplateContext(env);
}

/** Resolve all template strings in a step */
export function resolveStepTemplates(
  step: ChainedStep,
  context: TemplateContext,
): {
  resolved: Record<string, unknown>;
  conditionResult: boolean;
  errors: TemplateError[];
} {
  const resolved: Record<string, unknown> = {};
  const errors: TemplateError[] = [];

  // W3: keys that are recipe metadata, not tool params
  const STEP_META_KEYS = new Set([
    "id",
    "tool",
    "agent",
    "recipe",
    "chain",
    "awaits",
    "when",
    "output",
    "risk",
    "optional",
    "vars",
    "transform",
    "retry",
    "retryDelay",
    "parallel",
  ]);

  // Resolve tool params
  for (const [key, value] of Object.entries(step)) {
    if (STEP_META_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string" && value.includes("{{")) {
      const compiled = compileTemplate(value);
      const result = compiled.evaluate(context);
      if ("error" in result) {
        errors.push(result.error);
        resolved[key] = value;
      } else {
        // Try to parse JSON for structured data
        try {
          resolved[key] = JSON.parse(result.value);
        } catch {
          resolved[key] = result.value;
        }
      }
    } else {
      resolved[key] = value;
    }
  }

  // Resolve agent prompt if present
  if (step.agent && typeof step.agent.prompt === "string") {
    const compiled = compileTemplate(step.agent.prompt);
    const result = compiled.evaluate(context);
    if ("error" in result) {
      errors.push(result.error);
    } else {
      resolved.agentPrompt = result.value;
    }
  }

  // Evaluate when condition
  let conditionResult = true;
  if (step.when) {
    const compiled = compileTemplate(step.when);
    const result = compiled.evaluate(context);
    if ("error" in result) {
      errors.push(result.error);
      conditionResult = false;
    } else {
      // Simple truthiness check (empty string, "0", "false" are falsy)
      const val = result.value.trim().toLowerCase();
      conditionResult =
        !!val &&
        val !== "0" &&
        val !== "false" &&
        val !== "null" &&
        val !== "undefined";
    }
  }

  return { resolved, conditionResult, errors };
}

/** Execute a single step */
export async function executeChainedStep(
  ctx: StepExecutionContext,
  deps: ExecutionDeps,
): Promise<{
  success: boolean;
  skipped?: boolean;
  data?: unknown;
  error?: string;
  /** VD-2: resolved params after template substitution — captured by the
   *  runner for the dashboard's per-step view. */
  resolvedParams?: unknown;
}> {
  const { registry, step, options, depth } = ctx;
  const { dryRun } = options;

  // Build template context
  const templateContext = buildTemplateContext(registry, options.env);

  // Resolve templates
  const { resolved, conditionResult, errors } = resolveStepTemplates(
    step,
    templateContext,
  );

  if (errors.length > 0) {
    return {
      success: false,
      error: `Template errors: ${errors.map((e) => e.message).join(", ")}`,
    };
  }

  // Check when condition
  if (!conditionResult) {
    return {
      success: true,
      skipped: true,
      data: { skipped: true, reason: "when condition falsy" },
    };
  }

  // Dry run: just report what would happen
  if (dryRun) {
    const recipeRef = nestedRecipeRef(step);
    return {
      success: true,
      data: {
        dryRun: true,
        stepType: recipeRef ? "recipe" : step.agent ? "agent" : "tool",
        wouldExecute: (step.tool ?? step.agent) ? "prompt" : recipeRef,
        resolvedParams: Object.keys(resolved).length > 0 ? resolved : undefined,
      },
    };
  }

  /** Flat `{{ key }}` renderer for transform strings — mirrors yamlRunner.render */
  function applyTransform(
    template: string,
    rawResult: unknown,
    ctx: TemplateContext,
  ): unknown {
    const resultStr =
      typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    const flatCtx: Record<string, string> = { $result: resultStr };
    // Expose env keys as flat vars too
    for (const [k, v] of Object.entries(ctx.env)) {
      if (v !== undefined) flatCtx[k] = v;
    }
    try {
      return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
        const key = expr.trim();
        return Object.hasOwn(flatCtx, key) ? (flatCtx[key] ?? "") : "";
      });
    } catch {
      return rawResult;
    }
  }

  // VD-4 mocked replay: short-circuit BEFORE executing tool/agent. The
  // step still runs through template + condition resolution + transform
  // (so the user sees how upstream outputs flow downstream) but tool /
  // agent / nested-recipe execution is replaced with the captured
  // output from the original run. Templates may still re-resolve to
  // different values if the recipe was edited — that's expected; it's
  // what makes mocked replay useful for debugging template wiring.
  if (options.mockedOutputs?.has(step.id)) {
    let mockedData: unknown = options.mockedOutputs.get(step.id);
    if (step.transform) {
      try {
        mockedData = applyTransform(
          step.transform,
          mockedData,
          templateContext,
        );
      } catch (err) {
        console.warn(`transform failed for step ${step.id}: ${err}`);
      }
    }
    return {
      success: true,
      data: mockedData,
      resolvedParams: resolved,
    };
  }

  // Execute based on step type
  try {
    const recipeRef = nestedRecipeRef(step);
    if (recipeRef) {
      // Nested recipe call
      const nestedConfig: NestedRecipeConfig = {
        recipe: recipeRef,
        vars: step.vars ?? {},
        output: step.output ?? step.id,
        risk: step.risk,
        id: step.id,
      };

      const nestedContext: NestedRecipeContext = {
        parentRegistry: registry,
        parentEnv: options.env,
        recipeMaxDepth: options.maxDepth,
        currentDepth: depth,
        dryRun,
      };

      if (dryRun) {
        const result = await mockNestedRecipe(nestedConfig, nestedContext);
        return {
          success: result.success,
          data: result.data,
          error: result.error,
        };
      }

      // Load and execute nested recipe
      const nestedRecipe = await deps.loadNestedRecipe(
        recipeRef,
        options.sourcePath,
      );
      if (!nestedRecipe) {
        return {
          success: false,
          error: `Nested recipe "${recipeRef}" not found`,
        };
      }

      const validation = validateNestedRecipe(nestedConfig, nestedContext);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      // Resolve vars for child
      const { resolved: resolvedVars, errors: varErrors } = resolveNestedVars(
        step.vars ?? {},
        templateContext,
      );

      if (varErrors.length > 0) {
        return {
          success: false,
          error: `Variable template errors: ${varErrors.map((e) => e.message).join(", ")}`,
        };
      }

      // Execute child recipe with isolated registry
      const childRegistry = createOutputRegistry();
      const childOptions: RunOptions = {
        ...options,
        maxDepth: options.maxDepth,
        sourcePath: nestedRecipe.sourcePath,
        env: { ...options.env, ...resolvedVars }, // Merge resolved vars into env
      };

      const childResult = await runChainedRecipe(
        nestedRecipe.recipe,
        childOptions,
        deps,
        childRegistry,
        depth + 1,
      );

      return {
        success: !childResult.errorMessage,
        data: {
          recipe: recipeRef,
          childSummary: childRegistry.summary(),
          childOutputs: Object.fromEntries(
            childRegistry.keys().map((k) => [k, childRegistry.get(k)?.data]),
          ),
        },
      };
    } else if (step.agent) {
      // Agent step
      const prompt = (resolved.agentPrompt as string) ?? step.agent.prompt;
      let result: unknown = await deps.executeAgent(
        prompt,
        step.agent.model,
        step.agent.driver,
      );
      if (step.transform) {
        try {
          result = applyTransform(step.transform, result, templateContext);
        } catch (err) {
          console.warn(`transform failed for step ${step.id}: ${err}`);
        }
      }
      return { success: true, data: result, resolvedParams: resolved };
    } else if (step.tool) {
      // Tool step
      let result: unknown = await deps.executeTool(step.tool, resolved);
      if (step.transform) {
        try {
          result = applyTransform(step.transform, result, templateContext);
        } catch (err) {
          console.warn(`transform failed for step ${step.id}: ${err}`);
        }
      }
      return { success: true, data: result, resolvedParams: resolved };
    } else {
      return { success: false, error: "Step has no tool, agent, or recipe" };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

interface StepExecResult {
  success: boolean;
  skipped?: boolean;
  data?: unknown;
  error?: string;
  /** VD-2: forwarded from `executeChainedStep` so the runner can capture
   *  what params actually flew at the tool/agent. */
  resolvedParams?: unknown;
}

async function withRetry(
  fn: () => Promise<StepExecResult>,
  maxRetries: number,
  delayMs: number,
): Promise<StepExecResult> {
  let last: StepExecResult = { success: false };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    last = await fn();
    if (last.success) return last;
  }
  return last;
}

export interface ChainedStepRunResult {
  success: boolean;
  skipped?: boolean;
  durationMs?: number;
  error?: Error;
}

export interface ChainedRunResult {
  success: boolean;
  stepResults: Map<string, ChainedStepRunResult>;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  errorMessage?: string;
  /** Step output data keyed by step id, stringified for expect: assertions. */
  context: Record<string, string>;
}

/**
 * Expand `parallel:` sugar into flat steps with auto-generated ids and
 * correct `awaits` wiring so the existing dependency graph handles execution.
 *
 * A `parallel:` step is a group container — it has no id/tool/agent of its
 * own. Each child in the group inherits the group's `awaits` and is assigned
 * an id of `<groupId>_<index>`. Steps that previously awaited the group
 * (determined by a post-pass) are rewritten to await all children instead.
 *
 * Expansion is recursive so nested `parallel:` blocks work too.
 */
export function expandParallelSteps(steps: ChainedStep[]): ChainedStep[] {
  const flat: ChainedStep[] = [];
  // Maps a group placeholder id → the ids of its expanded children.
  const groupChildren = new Map<string, string[]>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    if (Array.isArray(step.parallel) && step.parallel.length > 0) {
      // Generate a stable group id from position if the group has no id.
      const groupId = step.id ?? `parallel_${i}`;
      const groupAwaits = step.awaits ?? [];
      const childIds: string[] = [];

      for (let j = 0; j < step.parallel.length; j++) {
        const child = step.parallel[j];
        if (!child) continue;
        const childId = child.id ?? `${groupId}_${j}`;
        childIds.push(childId);
        // Expand child recursively in case it also has parallel:.
        const expanded = expandParallelSteps([
          {
            ...child,
            id: childId,
            awaits: [...groupAwaits, ...(child.awaits ?? [])],
          },
        ]);
        flat.push(...expanded);
      }

      groupChildren.set(groupId, childIds);
    } else {
      flat.push(step);
    }
  }

  // Rewrite awaits: any step that awaited a group id now awaits all its children.
  if (groupChildren.size === 0) return flat;

  return flat.map((step) => {
    if (!step.awaits?.length) return step;
    const rewritten = step.awaits.flatMap(
      (dep) => groupChildren.get(dep) ?? [dep],
    );
    // Deduplicate while preserving order.
    const seen = new Set<string>();
    const deduped = rewritten.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return { ...step, awaits: deduped };
  });
}

/** Main entry point: run a chained recipe */
export async function runChainedRecipe(
  recipe: ChainedRecipe,
  options: RunOptions,
  deps: ExecutionDeps,
  existingRegistry?: OutputRegistry,
  depth = 0,
): Promise<ChainedRunResult> {
  // Load plugin servers declared in the recipe before executing any steps.
  // Only done at the top-level call (depth 0) to avoid redundant loads in nested recipes.
  if (depth === 0 && recipe.servers?.length) {
    try {
      const { loadRecipeServers } = await import("./yamlRunner.js");
      await loadRecipeServers(recipe.servers);
    } catch {
      // Non-fatal — if yamlRunner import fails, proceed without plugins
    }
  }

  const registry = existingRegistry ?? createOutputRegistry();

  // Expand parallel: sugar into flat steps before building the dependency graph.
  const steps = expandParallelSteps(recipe.steps);

  // Build dependency graph
  const depGraph = buildDependencyGraph(
    steps.map((s, i) => ({ id: s.id ?? `step_${i}`, awaits: s.awaits })),
  );

  const runStartedAt = Date.now();

  // Open a `running`-state run-log entry so the dashboard sees the recipe
  // as in flight (depth 0 only — nested recipes are part of their parent
  // run). The seq is used by VD-1 live-tail to correlate step events.
  const recipeTriggerKind =
    (recipe as unknown as { trigger?: { type?: string } }).trigger?.type ??
    "recipe";
  const triggerKind = (
    ["cron", "webhook", "recipe"].includes(recipeTriggerKind)
      ? recipeTriggerKind
      : "recipe"
  ) as "cron" | "webhook" | "recipe";
  const taskIdPrefix = options.taskIdPrefix ?? "chained";
  const runTaskId = `${taskIdPrefix}:${recipe.name}:${runStartedAt}`;
  let runSeq: number | undefined;
  if (depth === 0 && options.runLog) {
    try {
      runSeq = options.runLog.startRun({
        taskId: runTaskId,
        recipeName: recipe.name,
        trigger: triggerKind,
        createdAt: runStartedAt,
        startedAt: runStartedAt,
      });
    } catch {
      // Non-fatal — run-log failures must never break recipe execution.
    }
  }

  if (depGraph.hasCycles) {
    if (depth === 0) {
      const doneAt = Date.now();
      const durationMs = doneAt - runStartedAt;
      try {
        if (options.runLog && runSeq !== undefined) {
          options.runLog.completeRun(runSeq, {
            status: "error",
            doneAt,
            durationMs,
            stepResults: [],
            errorMessage: "Recipe has circular dependencies",
          });
        } else if (options.runLogDir) {
          const { RecipeRunLog } = await import("../runLog.js");
          const log = new RecipeRunLog({ dir: options.runLogDir });
          log.appendDirect({
            taskId: runTaskId,
            recipeName: recipe.name,
            trigger: triggerKind,
            status: "error",
            createdAt: runStartedAt,
            startedAt: runStartedAt,
            doneAt,
            durationMs,
            errorMessage: "Recipe has circular dependencies",
            stepResults: [],
          });
        }
      } catch {
        // Non-fatal — run-log failures must never break recipe execution.
      }
    }
    return {
      success: false,
      stepResults: new Map(),
      summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      errorMessage: "Recipe has circular dependencies",
      context: {},
    };
  }

  // Create step lookup from expanded steps.
  const stepMap = new Map<string, ChainedStep>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepId = step.id ?? `step_${i}`;
    stepMap.set(stepId, { ...step, id: stepId });
  }

  const stepTimings = new Map<
    string,
    { durationMs: number; skipped?: boolean }
  >();

  // VD-2: per-step capture (resolved params + output + registry snapshot).
  // Populated at the `registry.set(...)` site during step execution and
  // attached to the final `RunStepResult` written via `completeRun`.
  const capturedStepData = new Map<
    string,
    {
      resolvedParams?: unknown;
      output?: unknown;
      registrySnapshot?: Record<string, unknown>;
      startedAt: number;
    }
  >();

  // VD-1 live-tail: when an `activityLog` is provided AND we have a `runSeq`
  // (depth 0, runLog supplied), broadcast `recipe_step_start` /
  // `recipe_step_done` events so the dashboard `/runs/[seq]` page can
  // subscribe to step changes via SSE instead of 3s polling.
  const broadcastActivity = options.activityLog;
  const broadcastSeq = runSeq;
  const broadcastName = recipe.name;
  const stepStartTimes = new Map<string, number>();

  const wrappedOnStepStart =
    broadcastActivity && broadcastSeq !== undefined
      ? (stepId: string) => {
          const ts = Date.now();
          stepStartTimes.set(stepId, ts);
          try {
            broadcastActivity.recordEvent("recipe_step_start", {
              runSeq: broadcastSeq,
              recipeName: broadcastName,
              stepId,
              tool: stepMap.get(stepId)?.tool,
              ts,
            });
          } catch {
            // never let live-tail failure break the run
          }
          options.onStepStart?.(stepId);
        }
      : options.onStepStart;

  const wrappedOnStepComplete =
    broadcastActivity && broadcastSeq !== undefined
      ? (stepId: string, error?: Error) => {
          const ts = Date.now();
          const startedAt = stepStartTimes.get(stepId);
          try {
            broadcastActivity.recordEvent("recipe_step_done", {
              runSeq: broadcastSeq,
              recipeName: broadcastName,
              stepId,
              tool: stepMap.get(stepId)?.tool,
              status: error ? "error" : "ok",
              ...(error?.message !== undefined && { error: error.message }),
              ...(startedAt !== undefined && {
                durationMs: ts - startedAt,
              }),
              ts,
            });
          } catch {
            // never let live-tail failure break the run
          }
          options.onStepComplete?.(stepId, error);
        }
      : options.onStepComplete;

  // Execute with dependency tracking
  const execOptions: ExecutionOptions = {
    maxConcurrency: options.maxConcurrency,
    onStepStart: wrappedOnStepStart,
    onStepComplete: wrappedOnStepComplete,
  };

  const stepExecutor: StepExecutor = async (stepId: string) => {
    const step = stepMap.get(stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    const ctx: StepExecutionContext = {
      registry,
      step,
      options,
      recipe,
      depth,
    };

    const retryCount = step.retry ?? recipe.on_error?.retry ?? 0;
    const retryDelay = step.retryDelay ?? recipe.on_error?.retryDelay ?? 1000;
    const stepStart = Date.now();
    const result = await withRetry(
      () => executeChainedStep(ctx, deps),
      retryCount,
      retryDelay,
    );
    stepTimings.set(stepId, {
      durationMs: Date.now() - stepStart,
      skipped: result.skipped,
    });

    // Recipe-level on_error.fallback: "log_only" and "deliver_original" both
    // treat step failures as non-fatal (fail-open) — same semantics as
    // step-level optional: true. "abort" is the default (propagate failure).
    const recipeFallback = recipe.on_error?.fallback;
    const recipeFallbackFailOpen =
      recipeFallback === "log_only" || recipeFallback === "deliver_original";
    const isOptional = step.optional === true || recipeFallbackFailOpen;
    const effectiveSuccess = result.success || isOptional;

    if (!result.success && recipeFallbackFailOpen && !step.optional) {
      console.warn(
        `step ${stepId} failed but on_error.fallback=${recipeFallback} — treating as non-fatal: ${
          result.error ?? "unknown error"
        }`,
      );
    }

    // Store output in registry with accurate status
    registry.set(stepId, {
      status: result.skipped
        ? "skipped"
        : result.success
          ? "success"
          : isOptional
            ? "success"
            : "error",
      data: result.data,
    });

    // VD-2: capture per-step inputs/outputs/registry snapshot for the
    // dashboard's diff hover + replay. Only at depth 0 (nested steps are
    // part of their parent's audit) and only when we have a runSeq +
    // runLog to push into. Sensitive keys are redacted; large values
    // truncated to 8 KB.
    if (depth === 0 && options.runLog && runSeq !== undefined) {
      try {
        const snapshot: Record<string, unknown> = {};
        for (const k of registry.keys()) {
          const v = registry.get(k);
          if (v !== undefined) snapshot[k] = v;
        }
        capturedStepData.set(stepId, {
          resolvedParams: captureForRunlog(result.resolvedParams),
          output: captureForRunlog(result.data),
          registrySnapshot: captureForRunlog(snapshot) as
            | Record<string, unknown>
            | undefined,
          startedAt: stepStart,
        });
      } catch {
        // Capture is best-effort — never let a serialization failure
        // break the run.
      }
    }

    // Optional steps must not propagate failure to the executor
    if (!effectiveSuccess) {
      throw new Error(result.error ?? `Step ${stepId} failed`);
    }
  };

  const stepResults = await executeWithDependencies(
    depGraph,
    stepExecutor,
    execOptions,
  );

  // Merge timings into step results
  const enrichedResults = new Map<string, ChainedStepRunResult>();
  let failed = 0;
  for (const [id, result] of stepResults) {
    const timing = stepTimings.get(id);
    enrichedResults.set(id, {
      ...result,
      skipped: timing?.skipped,
      durationMs: timing?.durationMs,
    });
    if (!result.success) failed++;
  }

  // Build string context map from registry for expect: assertions
  const context: Record<string, string> = {};
  for (const id of registry.keys()) {
    const entry = registry.get(id);
    if (entry?.data !== undefined) {
      context[id] =
        typeof entry.data === "string"
          ? entry.data
          : JSON.stringify(entry.data);
    }
  }

  const result: ChainedRunResult = {
    success: failed === 0,
    stepResults: enrichedResults,
    summary: registry.summary(),
    errorMessage: failed > 0 ? `${failed} step(s) failed` : undefined,
    context,
  };

  // Write to RecipeRunLog so the dashboard Runs page shows chained executions.
  // Only top-level (depth 0) runs are logged — nested recipe calls are part of
  // their parent's run. Failures here must never break recipe execution.
  //
  // Two paths:
  //  - `options.runLog` (bridge-driven): we already called `startRun` above.
  //    Finalize via `completeRun` so the dashboard sees the live status flip.
  //  - `options.runLogDir` (CLI): construct a local log + `appendDirect`.
  //    No live-tail, but back-compat with the pre-VD-1 CLI flow.
  if (depth === 0 && (options.runLog || options.runLogDir)) {
    try {
      const doneAt = Date.now();
      const stepResultsList: Array<{
        id: string;
        tool?: string;
        status: "ok" | "skipped" | "error";
        error?: string;
        durationMs: number;
        // VD-2 capture (only attached when present in `capturedStepData`).
        resolvedParams?: unknown;
        output?: unknown;
        registrySnapshot?: Record<string, unknown>;
        startedAt?: number;
      }> = [];
      for (const [id, r] of enrichedResults) {
        const step = stepMap.get(id);
        const captured = capturedStepData.get(id);
        stepResultsList.push({
          id,
          tool: step?.tool,
          status: r.skipped ? "skipped" : r.success ? "ok" : "error",
          error: r.error?.message,
          durationMs: r.durationMs ?? 0,
          ...(captured?.resolvedParams !== undefined && {
            resolvedParams: captured.resolvedParams,
          }),
          ...(captured?.output !== undefined && { output: captured.output }),
          ...(captured?.registrySnapshot !== undefined && {
            registrySnapshot: captured.registrySnapshot,
          }),
          ...(captured?.startedAt !== undefined && {
            startedAt: captured.startedAt,
          }),
        });
      }
      const outputTail = stepResultsList
        .map(
          (s) =>
            `[${s.status}] ${s.tool ?? s.id}${s.error ? `: ${s.error}` : ""}`,
        )
        .join("\n")
        .slice(0, 2000);
      if (options.runLog && runSeq !== undefined) {
        options.runLog.completeRun(runSeq, {
          status: result.success ? "done" : "error",
          doneAt,
          durationMs: doneAt - runStartedAt,
          stepResults: stepResultsList,
          outputTail,
          ...(result.errorMessage !== undefined && {
            errorMessage: result.errorMessage,
          }),
        });
      } else if (options.runLogDir) {
        const { RecipeRunLog } = await import("../runLog.js");
        const log = new RecipeRunLog({ dir: options.runLogDir });
        log.appendDirect({
          taskId: runTaskId,
          recipeName: recipe.name,
          trigger: triggerKind,
          status: result.success ? "done" : "error",
          createdAt: runStartedAt,
          startedAt: runStartedAt,
          doneAt,
          durationMs: doneAt - runStartedAt,
          outputTail,
          errorMessage: result.errorMessage,
          stepResults: stepResultsList,
        });
      }
    } catch {
      // Non-fatal — run log write failure must never break recipe execution
    }
  }

  return result;
}

/** Generate execution plan for dry-run mode */
export function generateExecutionPlan(recipe: ChainedRecipe): {
  steps: Array<{
    id: string;
    type: "tool" | "agent" | "recipe";
    dependencies: string[];
    condition?: string;
    risk: "low" | "medium" | "high";
    optional?: boolean;
  }>;
  parallelGroups: string[][];
  maxDepth: number;
} {
  const expandedSteps = expandParallelSteps(recipe.steps);
  const depGraph = buildDependencyGraph(
    expandedSteps.map((s, i) => ({
      id: s.id ?? `step_${i}`,
      awaits: s.awaits,
    })),
  );

  // Group by topological levels (parallelizable)
  const levels: string[][] = [];
  const completed = new Set<string>();

  while (completed.size < depGraph.topologicalOrder.length) {
    const ready = depGraph.topologicalOrder.filter(
      (id) =>
        !completed.has(id) &&
        depGraph.steps
          .find((s) => s.stepId === id)
          ?.awaits.every((dep) => completed.has(dep)),
    );
    if (ready.length === 0) break;
    levels.push(ready);
    for (const id of ready) completed.add(id);
  }

  return {
    steps: expandedSteps.map((s) => ({
      id: s.id ?? "",
      type: nestedRecipeRef(s) ? "recipe" : s.agent ? "agent" : "tool",
      dependencies: s.awaits ?? [],
      condition: s.when,
      risk: s.risk ?? "low",
      optional: s.optional,
    })),
    parallelGroups: levels,
    maxDepth: recipe.maxDepth ?? 3,
  };
}
