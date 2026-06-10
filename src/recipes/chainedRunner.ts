/**
 * ChainedRecipeRunner — executes recipes with:
 *   - Parallel step execution (respecting dependencies)
 *   - Template-based variable resolution
 *   - Nested recipe calls
 *   - Conditional step execution (when)
 *   - Dry-run mode
 */

import type { AgentResult } from "./agentExecutor.js";
import type { ExecutionOptions, StepExecutor } from "./dependencyGraph.js";
import {
  buildDependencyGraph,
  executeWithDependencies,
} from "./dependencyGraph.js";
import {
  categoriseHaltReason,
  deriveHaltReasonFromError,
} from "./haltCategory.js";
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
import type { RouteCandidate } from "./pricing/costRouter.js";
import { loadPriceTable, type PriceTable } from "./pricing/priceTable.js";
import { resolveRecipePath } from "./resolveRecipePath.js";
import { RunBudget } from "./runBudget.js";
import type { BudgetPolicy, ErrorPolicy } from "./schema.js";
import { captureForRunlog, detectSilentFail } from "./stepObservation.js";
import type { TemplateContext, TemplateError } from "./templateEngine.js";
import { compileTemplate } from "./templateEngine.js";
import type { StepExpect } from "./yamlRunner.js";
import {
  computeAgentCallUsage,
  evaluateStepExpect,
  resolveRouting,
} from "./yamlRunner.js";

export interface ChainedStep {
  id: string;
  tool?: string;
  agent?: {
    prompt: string;
    model?: string;
    driver?: string;
    /** Cost-aware routing fallbacks (Phase 4) — mirrors the flat path. */
    downshift?: RouteCandidate[];
    mcpAccess?: boolean;
  };
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
  /**
   * Per-step wall-clock timeout (ms). When >0, the tool/agent dispatch is raced
   * against a timer; on expiry the step fails with `step_timeout` (the
   * underlying call keeps running but its result is ignored). Mirrors the flat
   * yamlRunner's `timeout_ms` — audit 2026-06-08 (recipe-chained-4).
   */
  timeout_ms?: number;
  transform?: string; // template rendered after tool execution; $result = raw tool output
  expect?: StepExpect;
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
  /**
   * Per-recipe token / USD budget. Mirrors the flat (yamlRunner) path: one
   * `RunBudget` is constructed per top-level run, agent steps consult it
   * before dispatch (admission) and reconcile actual consumption after. Absent
   * → no enforcement, no overhead. SECURITY: without this thread a chained
   * recipe ran UNBOUNDED API calls (S1 finding).
   */
  budget?: BudgetPolicy;
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
  /**
   * seq of the parent run that caused this recipe to fire. Stored in the
   * run log entry so the dashboard can render the causal chain.
   */
  parentSeq?: number;
  /**
   * Shared per-run budget. Constructed once by the top-level
   * `runChainedRecipe` from `recipe.budget` and threaded into nested recipe
   * calls so the whole tree shares one cap (mirrors the flat path's single
   * `RunBudget` per run). Internal — callers don't set this.
   */
  budget?: RunBudget;
  /**
   * Price table loaded once per top-level run and inherited by nested recipe
   * calls (same lifetime as `budget`) so per-step usage costing avoids a
   * synchronous disk round-trip. Internal — callers don't set this.
   */
  priceTable?: PriceTable;
}

export interface StepExecutionContext {
  registry: OutputRegistry;
  step: ChainedStep;
  options: RunOptions;
  recipe: ChainedRecipe;
  depth: number;
  /** Shared per-run budget (admit before dispatch, reconcile after). */
  budget?: RunBudget;
  /**
   * Price table loaded ONCE per run and threaded through so each agent step's
   * `computeAgentCallUsage` call avoids a synchronous existsSync/readFileSync
   * round-trip (mirrors the flat runner, which loads it once at run start).
   */
  priceTable?: PriceTable;
}

export type ToolExecutor = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Agent dispatch closure. Returns either a bare string (legacy / simple test
 * mocks) or an `AgentResult` carrying `usage` + `servedBy` so the chained
 * runner can reconcile real spend against the run budget (alignment with the
 * flat path — previously the yamlRunner closure discarded `.usage`).
 */
export type AgentExecutor = (
  prompt: string,
  model?: string,
  driver?: string,
) => Promise<string | AgentResult>;

/** Normalise the union AgentExecutor return into an AgentResult. */
function toChainedAgentResult(v: string | AgentResult): AgentResult {
  return typeof v === "string" ? { text: v } : v;
}

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
    // Runner-meta declared on ChainedStep — must NOT be forwarded as tool
    // params (the `expect` AJV schema object + numeric timeout especially leak
    // internal runner config into tools that log their raw params).
    "expect",
    "timeout_ms",
    "silentFailDetection",
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

  // R2 C-1 / F-02 defense-in-depth: every chained-runner template substitution
  // site must re-validate `path` fields on file.* tools after rendering. The
  // per-tool jail in `tools/file.ts` is the primary check; this layer
  // catches paths that survived the chained substitution (e.g. via JSON
  // round-trip) and ensures `err.code === "recipe_path_jail_escape"` is
  // raised before the resolved step reaches executeTool dispatch.
  const toolId = typeof step.tool === "string" ? step.tool : undefined;
  if (
    (toolId === "file.read" ||
      toolId === "file.write" ||
      toolId === "file.append") &&
    typeof resolved.path === "string"
  ) {
    // Throws RecipePathJailError — propagates as a step error so the
    // chained runner's error-policy machinery can handle it (and tests can
    // assert on err.code without needing to inspect step results).
    resolveRecipePath(resolved.path, { write: toolId !== "file.read" });
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

/**
 * Race `work` against a per-step timeout. Returns `work` unchanged when no
 * positive timeout is set. On expiry the returned promise rejects with a
 * `step_timeout` error (executeChainedStep's catch turns that into a step
 * failure). The underlying call is not cancellable here — it keeps running but
 * its result is ignored — matching the flat runner's documented behaviour.
 */
function raceStepTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (typeof timeoutMs !== "number" || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`step_timeout: exceeded ${timeoutMs}ms in step "${label}"`),
      );
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  /**
   * P1 cost/token corpus — agent token usage for this step (chained steps
   * make exactly one agent call). Absent for tool steps and unmeasured
   * drivers. `costUsd` set only for a priceable billable model (never 0).
   */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /**
   * `expect` assertion failures recorded when `on_fail: "warn"` — the step
   * still succeeds (the run continues) but the warnings are surfaced on the
   * persisted step row / dashboard. Mirrors the flat runner's
   * `last.expectWarnings`. Absent when there are no warn-mode failures.
   */
  expectWarnings?: string[];
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
    // Expose env keys
    for (const [k, v] of Object.entries(ctx.env)) {
      if (v !== undefined) flatCtx[k] = v;
    }
    // Expose upstream step outputs as steps.<id>.data so transforms can reference them
    for (const [stepId, output] of Object.entries(ctx.steps)) {
      if (output?.data !== undefined) {
        const dataStr =
          typeof output.data === "string"
            ? output.data
            : JSON.stringify(output.data);
        flatCtx[`steps.${stepId}.data`] = dataStr;
        // Also expose as bare step id for convenience (matches flat runner ctx keys)
        flatCtx[stepId] = dataStr;
      }
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
        budget: ctx.budget, // share the single per-run budget across the tree
        priceTable: ctx.priceTable, // reuse the once-loaded price table
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

      // Budget admission BEFORE dispatch — mirrors the flat path. A denied
      // admission halts this step (and, via the dependency graph, its
      // dependents) with a `budget_exceeded`-categorised reason. SECURITY:
      // without this the chained path made UNBOUNDED API calls.
      const budget = ctx.budget;
      if (budget) {
        const admission = budget.admit();
        if (!admission.admitted) {
          return {
            success: false,
            error:
              admission.reason ?? "Run exceeded its budget — budget_exceeded.",
            resolvedParams: resolved,
          };
        }
      }

      // Phase 4: opt-in cost-aware routing. No-op when the step has no
      // `downshift` list or no USD cap is set on the run budget.
      let dispatchDriver = step.agent.driver;
      let dispatchModel = step.agent.model;
      if (budget && step.agent.downshift?.length) {
        const routed = resolveRouting(
          { driver: step.agent.driver, model: step.agent.model },
          step.agent.downshift,
          prompt,
          budget,
        );
        dispatchDriver = routed.driver === "api" ? "anthropic" : routed.driver;
        dispatchModel = routed.model;
      }

      const agentReturn = toChainedAgentResult(
        await raceStepTimeout(
          deps.executeAgent(prompt, dispatchModel, dispatchDriver),
          step.timeout_ms,
          step.id,
        ),
      );

      // Reconcile REAL usage after dispatch (the closure now surfaces it
      // instead of discarding it). Subscription drivers report no usage →
      // RunBudget fails open with a one-time warning.
      if (budget) {
        // Normalize the "api" alias to "anthropic" on the no-downshift
        // fallback path too (the downshift branch already does this at line
        // 596). Without this, a bare-string AgentExecutor return with
        // `agent.driver: "api"` reconciles against a non-billable driver and
        // the USD cap is silently unenforced even though the call was billed.
        const reconcileDriver =
          agentReturn.servedBy?.driver ??
          (dispatchDriver === "api" ? "anthropic" : (dispatchDriver ?? "auto"));
        budget.reconcile(
          reconcileDriver,
          agentReturn.usage,
          agentReturn.servedBy?.model ?? dispatchModel,
          {
            inputChars: prompt.length,
            outputChars: agentReturn.text.length,
          },
        );
      }

      // P1: per-step agent token usage (chained = one agent call per step).
      // Attached to every return below so it lands on the persisted step row
      // regardless of success / failure. Absent for unmeasured drivers.
      // Thread the once-loaded price table to avoid per-step disk I/O.
      const usage = computeAgentCallUsage(
        agentReturn.usage,
        agentReturn.servedBy,
        ctx.priceTable,
      );

      let result: unknown = agentReturn.text;
      // Detect failure signals returned as sentinel strings (mirrors flat runner)
      if (
        typeof result === "string" &&
        result.startsWith("[agent step failed:")
      ) {
        return {
          success: false,
          error: result,
          resolvedParams: resolved,
          ...(usage ? { usage } : {}),
        };
      }
      const agentSilentFail =
        step.silentFailDetection !== false ? detectSilentFail(result) : null;
      if (agentSilentFail) {
        const reason = `silent-fail detected (${agentSilentFail.reason}): ${agentSilentFail.matched}`;
        return {
          success: false,
          error: reason,
          resolvedParams: resolved,
          ...(usage ? { usage } : {}),
        };
      }
      if (step.transform) {
        try {
          result = applyTransform(step.transform, result, templateContext);
        } catch (err) {
          console.warn(`transform failed for step ${step.id}: ${err}`);
        }
      }
      let agentExpectWarnings: string[] | undefined;
      if (step.expect) {
        const failures = await evaluateStepExpect(step.expect, result);
        if (failures.length > 0) {
          if ((step.expect.on_fail ?? "halt") === "halt") {
            return {
              success: false,
              error: `expect failed: ${failures.join("; ")}`,
              resolvedParams: resolved,
              ...(usage ? { usage } : {}),
            };
          }
          // on_fail: "warn" — keep going but surface the failures (mirrors
          // the flat runner's `last.expectWarnings`); previously dropped.
          agentExpectWarnings = failures;
        }
      }
      return {
        success: true,
        data: result,
        resolvedParams: resolved,
        ...(usage ? { usage } : {}),
        ...(agentExpectWarnings ? { expectWarnings: agentExpectWarnings } : {}),
      };
    } else if (step.tool) {
      // Tool step
      let result: unknown = await raceStepTimeout(
        deps.executeTool(step.tool, resolved),
        step.timeout_ms,
        step.id,
      );
      // Detect tool-level errors reported as JSON {ok: false, error: ...} (mirrors flat runner)
      if (typeof result === "string") {
        try {
          const parsed = JSON.parse(result) as Record<string, unknown>;
          if (parsed.ok === false && typeof parsed.error === "string") {
            return {
              success: false,
              error: parsed.error,
              resolvedParams: resolved,
            };
          }
        } catch {
          /* non-JSON result is fine */
        }
      }
      const toolSilentFail =
        step.silentFailDetection !== false ? detectSilentFail(result) : null;
      if (toolSilentFail) {
        const reason = `silent-fail detected (${toolSilentFail.reason}): ${toolSilentFail.matched}`;
        return { success: false, error: reason, resolvedParams: resolved };
      }
      if (step.transform) {
        try {
          result = applyTransform(step.transform, result, templateContext);
        } catch (err) {
          console.warn(`transform failed for step ${step.id}: ${err}`);
        }
      }
      let toolExpectWarnings: string[] | undefined;
      if (step.expect) {
        const failures = await evaluateStepExpect(step.expect, result);
        if (failures.length > 0) {
          if ((step.expect.on_fail ?? "halt") === "halt") {
            return {
              success: false,
              error: `expect failed: ${failures.join("; ")}`,
              resolvedParams: resolved,
            };
          }
          // on_fail: "warn" — keep going but surface the failures (mirrors
          // the flat runner's `last.expectWarnings`); previously dropped.
          toolExpectWarnings = failures;
        }
      }
      return {
        success: true,
        data: result,
        resolvedParams: resolved,
        ...(toolExpectWarnings ? { expectWarnings: toolExpectWarnings } : {}),
      };
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
  /** P1: agent token usage for this step — forwarded from
   *  `executeChainedStep`. Absent for tool / unmeasured-driver steps. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** `expect` assertion failures recorded under `on_fail: "warn"` — forwarded
   *  from `executeChainedStep` so the runner can attach them to the step row. */
  expectWarnings?: string[];
}

/** Upper bound on retries — clamps absurd/misconfigured values so a recipe
 *  can't spin a step unboundedly. Mirrors the `maximum` on `retry` in the
 *  recipe JSON schema. */
const MAX_RETRIES = 20;

async function withRetry(
  fn: () => Promise<StepExecResult>,
  maxRetries: number,
  delayMs: number,
): Promise<StepExecResult> {
  // Audit 2026-06-03 (HIGH #8): clamp the retry count. A negative value (typo
  // like `retry: -1`) made `attempt <= maxRetries` immediately false, so the
  // step NEVER ran and silently reported as failed. A non-finite or huge value
  // would spin unboundedly. Floor to an integer in [0, MAX_RETRIES]; non-finite
  // → 0 (run once, no retries).
  const safeRetries = Number.isFinite(maxRetries)
    ? Math.min(MAX_RETRIES, Math.max(0, Math.floor(maxRetries)))
    : 0;
  let last: StepExecResult = { success: false };
  for (let attempt = 0; attempt <= safeRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    last = await fn();
    if (last.success) return last;
    // Audit 2026-06-10 recipe-runners-2: do NOT retry on a step_timeout. The
    // timed-out attempt's tool/agent call keeps running in the background
    // (raceStepTimeout only abandons the wait, it does not cancel the call);
    // re-issuing the step is pointless for write tools (the in-flight
    // idempotency ledger short-circuits the retry to the same promise) and a
    // duplicate-side-effect hazard for any tool the ledger cannot dedup. A
    // true cancel needs an AbortSignal threaded through every tool/connector,
    // which is out of scope; refusing to retry on timeout is the safe contract.
    if (last.error?.startsWith("step_timeout:")) return last;
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
  // Track all assigned step ids to detect duplicates early.
  const seenIds = new Set<string>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    if (Array.isArray(step.parallel) && step.parallel.length > 0) {
      // Generate a stable group id from position if the group has no id.
      const groupId = step.id ?? `parallel_${i}`;
      // Track the group container id too — otherwise a later flat step reusing
      // the same id passes the duplicate check and silently corrupts the
      // dependency graph (dependents `awaits: [groupId]` are rewritten to the
      // group's children, never the shadowed flat step).
      if (seenIds.has(groupId)) {
        throw new Error(
          `expandParallelSteps: duplicate step id "${groupId}" — each step id must be unique`,
        );
      }
      seenIds.add(groupId);
      const groupAwaits = step.awaits ?? [];
      const childIds: string[] = [];

      for (let j = 0; j < step.parallel.length; j++) {
        const child = step.parallel[j];
        if (!child) continue;
        const childId = child.id ?? `${groupId}_${j}`;
        if (seenIds.has(childId)) {
          throw new Error(
            `expandParallelSteps: duplicate step id "${childId}" — each step id must be unique across all parallel groups`,
          );
        }
        seenIds.add(childId);
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
    } else if (
      typeof step.parallel === "object" &&
      step.parallel !== null &&
      !Array.isArray(step.parallel) &&
      "each" in (step.parallel as Record<string, unknown>)
    ) {
      // parallel: { each, as, steps } — runtime map-reduce over an array that a
      // PRIOR step produces. Real support needs dynamic agent fan-out (per-iter
      // budget/judge/silent-fail) the chained engine doesn't have yet, and the
      // array isn't known at plan-expansion time. This object form used to fall
      // through to the flat-step branch below and execute ZERO iterations —
      // silent data loss with no signal. Fail loud instead. (audit
      // recipe-chained-1)
      throw new Error(
        `Step "${step.id ?? `parallel_${i}`}" uses parallel:{ each } ` +
          `(runtime map-reduce), which is not yet implemented in chained ` +
          "recipes. Use the `fan_out` tool step for tool-only loops; agent " +
          "fan-out over a runtime-produced array is not yet supported.",
      );
    } else {
      if (step.id && seenIds.has(step.id)) {
        throw new Error(
          `expandParallelSteps: duplicate step id "${step.id}" — each step id must be unique`,
        );
      }
      if (step.id) seenIds.add(step.id);
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

  // Per-run budget: build once at the top level from `recipe.budget`; nested
  // recipe calls inherit the SAME instance via `options.budget` so the whole
  // tree shares one cap (mirrors the flat path's single RunBudget per run).
  // Absent `recipe.budget` → an empty RunBudget whose admit/reconcile are
  // no-ops, so there's no behaviour change for budget-less recipes.
  const budget = options.budget ?? new RunBudget(recipe.budget);
  // True only when THIS call constructed the budget — used to gate
  // refreshPrices() so an injected (unit-test) budget keeps its stable prices
  // and nested calls don't double-refresh the shared parent budget.
  const ownsBudget = options.budget === undefined;

  // Load the price table ONCE per run (inherited by nested recipe calls via
  // options.priceTable) so each agent step's computeAgentCallUsage avoids a
  // synchronous existsSync/readFileSync round-trip — mirrors the flat runner.
  const priceTable = options.priceTable ?? loadPriceTable();

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
        ...(options.parentSeq !== undefined && {
          parentSeq: options.parentSeq,
        }),
      });
    } catch {
      // Non-fatal — run-log failures must never break recipe execution.
    }
  }

  // A phantom `awaits:` target (one matching no real step) is invisible to
  // cycle detection but would silently drop the awaiting step and its
  // dependents from execution while the run still reports success. Reject
  // the run with a descriptive error BEFORE executing any step, mirroring
  // the circular-dependency guard below.
  const fatalGraphError =
    depGraph.unknownAwaitTargets.length > 0
      ? `Recipe has steps that await unknown step(s): ${depGraph.unknownAwaitTargets.join(", ")}`
      : depGraph.hasCycles
        ? "Recipe has circular dependencies"
        : undefined;

  if (fatalGraphError) {
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
            errorMessage: fatalGraphError,
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
            errorMessage: fatalGraphError,
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
      errorMessage: fatalGraphError,
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
  // P1 cost/token corpus — per-step agent usage, keyed by stepId. Populated
  // for every depth-0 agent step (independent of the VD-2 runLog-gated
  // capture above) so both the bridge and CLI persistence paths get it.
  const capturedUsage = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd?: number }
  >();
  // `expect` warnings (on_fail: "warn") per depth-0 step, keyed by stepId, so
  // they land on the persisted step row instead of being silently dropped.
  const capturedExpectWarnings = new Map<string, string[]>();

  // VD-1 live-tail: when an `activityLog` is provided AND we have a `runSeq`
  // (depth 0, runLog supplied), broadcast `recipe_step_start` /
  // `recipe_step_done` events so the dashboard `/runs/[seq]` page can
  // subscribe to step changes via SSE instead of 3s polling.
  const broadcastActivity = options.activityLog;
  const broadcastSeq = runSeq;
  const broadcastName = recipe.name;
  const stepStartTimes = new Map<string, number>();
  const broadcastRunStartedAt = Date.now();

  // Emit recipe_started immediately. Dashboard RecipeRunInline watches
  // this event to flip a row from "queued" to "running" before the
  // first step lands.
  if (broadcastActivity && broadcastSeq !== undefined) {
    try {
      broadcastActivity.recordEvent("recipe_started", {
        runSeq: broadcastSeq,
        recipeName: broadcastName,
        totalSteps: recipe.steps?.length ?? 0,
        ts: broadcastRunStartedAt,
      });
    } catch {
      /* live-tail must not break a recipe run */
    }
  }

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
            const stepDef = stepMap.get(stepId);
            const haltReason =
              error?.message !== undefined
                ? deriveHaltReasonFromError({
                    stepId,
                    toolName: stepDef?.tool,
                    isAgent: !!stepDef?.agent,
                    status: "error",
                    error: error.message,
                  })
                : undefined;
            broadcastActivity.recordEvent("recipe_step_done", {
              runSeq: broadcastSeq,
              recipeName: broadcastName,
              stepId,
              tool: stepDef?.tool,
              status: error ? "error" : "ok",
              ...(error?.message !== undefined && { error: error.message }),
              ...(startedAt !== undefined && {
                durationMs: ts - startedAt,
              }),
              ...(haltReason !== undefined && {
                haltReason,
                haltCategory: categoriseHaltReason(haltReason),
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

    // Honour the refreshPrices() contract for long-running recipes: pick up a
    // mid-run ~/.patchwork/prices.json update for budget enforcement. No-op
    // unless a usdMax cap is set; gated on ownsBudget so an injected
    // (unit-test) budget keeps its stable prices.
    if (ownsBudget) budget.refreshPrices();

    const ctx: StepExecutionContext = {
      registry,
      step,
      options,
      recipe,
      depth,
      budget,
      priceTable,
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
    // P1: stash this step's agent token usage (depth-0 persistence reads it).
    if (depth === 0 && result.usage) {
      capturedUsage.set(stepId, result.usage);
    }
    // Stash on_fail:"warn" expect failures so the persisted step row + the
    // dashboard surface them (previously silently dropped in chained runs).
    if (depth === 0 && result.expectWarnings?.length) {
      capturedExpectWarnings.set(stepId, result.expectWarnings);
    }

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
        /** One-sentence human-actionable halt reason — see StepResult in yamlRunner.ts. */
        haltReason?: string;
        durationMs: number;
        // VD-2 capture (only attached when present in `capturedStepData`).
        resolvedParams?: unknown;
        output?: unknown;
        registrySnapshot?: Record<string, unknown>;
        startedAt?: number;
        // P1 cost/token corpus.
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        // `expect` warnings (on_fail: "warn") — mirrors yamlRunner's StepResult.
        expectWarnings?: string[];
      }> = [];
      // P1: run-level token aggregate, summed from per-step agent usage.
      const runTok = { inputTokens: 0, outputTokens: 0, measured: false };
      let runCostUsd: number | undefined;
      for (const [id, r] of enrichedResults) {
        const step = stepMap.get(id);
        const captured = capturedStepData.get(id);
        const status = r.skipped ? "skipped" : r.success ? "ok" : "error";
        const errorMsg = r.error?.message;
        // Mirror the haltReason convention from yamlRunner.ts so chained
        // runs surface on the same dashboard pills + morning summary as
        // top-level runs.
        const haltReason = deriveHaltReasonFromError({
          stepId: id,
          toolName: step?.tool,
          isAgent: !!step?.agent,
          status,
          error: errorMsg,
        });
        const expectWarnings = capturedExpectWarnings.get(id);
        const usage = capturedUsage.get(id);
        if (usage) {
          runTok.measured = true;
          runTok.inputTokens += usage.inputTokens;
          runTok.outputTokens += usage.outputTokens;
          if (typeof usage.costUsd === "number") {
            runCostUsd = (runCostUsd ?? 0) + usage.costUsd;
          }
        }
        stepResultsList.push({
          id,
          tool: step?.tool,
          status,
          error: errorMsg,
          ...(haltReason !== undefined && { haltReason }),
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
          // P1: per-step token usage (absent for tool / unmeasured steps).
          ...(usage
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                ...(typeof usage.costUsd === "number"
                  ? { costUsd: usage.costUsd }
                  : {}),
              }
            : {}),
          ...(expectWarnings?.length ? { expectWarnings } : {}),
        });
      }
      // P1: assemble run-level totals (only when any step reported usage) +
      // budget totals (only when a budget was configured).
      const tokenTotals = runTok.measured
        ? {
            inputTokens: runTok.inputTokens,
            outputTokens: runTok.outputTokens,
            ...(typeof runCostUsd === "number" ? { costUsd: runCostUsd } : {}),
          }
        : undefined;
      const budgetTotals = recipe.budget ? budget.totals() : undefined;
      const outputTail = stepResultsList
        .map(
          (s) =>
            `[${s.status}] ${s.tool ?? s.id}${s.error ? `: ${s.error}` : ""}`,
        )
        .join("\n")
        .slice(0, 2000);
      // Budget warnings/spend — record like the flat path so chained runs
      // surface spend + fail-open notices on the same dashboard surfaces.
      const budgetWarnings = budget.finalWarnings();
      if (options.runLog && runSeq !== undefined) {
        options.runLog.completeRun(runSeq, {
          status: result.success ? "done" : "error",
          doneAt,
          durationMs: doneAt - runStartedAt,
          stepResults: stepResultsList,
          outputTail,
          ...(budgetWarnings.length > 0 && { budgetWarnings }),
          ...(result.errorMessage !== undefined && {
            errorMessage: result.errorMessage,
          }),
          ...(tokenTotals ? { tokenTotals } : {}),
          ...(budgetTotals ? { budgetTotals } : {}),
        });
        if (broadcastActivity && broadcastSeq !== undefined) {
          try {
            broadcastActivity.recordEvent("recipe_done", {
              runSeq: broadcastSeq,
              recipeName: broadcastName,
              status: result.success ? "done" : "error",
              durationMs: doneAt - runStartedAt,
              stepCount: stepResultsList.length,
              ...(result.errorMessage !== undefined && {
                errorMessage: result.errorMessage,
              }),
              ts: doneAt,
            });
          } catch {
            /* live-tail must not break a recipe run */
          }
        }
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
          ...(budgetWarnings.length > 0 && { budgetWarnings }),
          ...(tokenTotals ? { tokenTotals } : {}),
          ...(budgetTotals ? { budgetTotals } : {}),
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
    /**
     * F-07 fix: emit the underlying step shape so the dry-plan's
     * write-detection can recurse into nested recipes and the registry
     * lookup in `enrichStepFromRegistry` can resolve the tool. Previously
     * `commands/recipe.ts` had to type-cheat with `as unknown as { tool?:
     * unknown; into?: unknown }` to read these — that cast is gone now.
     */
    tool?: string;
    into?: string;
    recipe?: string;
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
    steps: expandedSteps.map((s) => {
      const nestedRef = nestedRecipeRef(s);
      const stepType: "tool" | "agent" | "recipe" = nestedRef
        ? "recipe"
        : s.agent
          ? "agent"
          : "tool";
      return {
        id: s.id ?? "",
        type: stepType,
        dependencies: s.awaits ?? [],
        condition: s.when,
        risk: s.risk ?? "low",
        optional: s.optional,
        ...(typeof s.tool === "string" && { tool: s.tool }),
        ...(typeof s.into === "string" && { into: s.into }),
        ...(nestedRef !== undefined && { recipe: nestedRef }),
      };
    }),
    parallelGroups: levels,
    maxDepth: recipe.maxDepth ?? 3,
  };
}
