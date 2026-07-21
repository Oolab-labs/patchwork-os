import type { ValidateFunction } from "ajv";
import cron from "node-cron";
import { createAjv2020, type ErrorObject } from "../ajv2020.js";
import { FLAG_SCHEMA_LINT, isEnabled } from "../featureFlags.js";
import {
  defaultDeprecationWarn,
  normalizeRecipeForRuntime,
} from "./migrations/index.js";
import {
  RECIPE_NAME_RE,
  RECIPE_VAR_NAME_RE,
  RESERVED_VAR_NAMES,
} from "./names.js";
import { generateSchemaSet } from "./schemaGenerator.js";
import { listToolOutputContextKeys } from "./toolRegistry.js";

/** Driver ids a `downshift` candidate may name (mirrors the JSON-schema enum). */
const DOWNSHIFT_KNOWN_DRIVERS = new Set([
  "claude",
  "claude-code",
  "api",
  "openai",
  "grok",
  "gemini",
  "anthropic",
  "codex",
  "local",
]);

export interface LintIssue {
  level: "error" | "warning";
  message: string;
  /** 1-indexed line in the source YAML, when available (populated in a later phase). */
  line?: number;
  /** 0-indexed column in the source YAML, when available. */
  column?: number;
  /**
   * Stable, machine-readable code for UI keying. Schema-validation issues
   * use the AJV keyword (`required`, `type`, `enum`, ...); future hand-rolled
   * checks can adopt their own short kebab-case codes. Optional — older
   * issues without a code render the same way they always did.
   */
  code?: string;
  /**
   * Dot-separated path into the recipe object pointing at the offending
   * field (e.g. `steps.0.tool` or `trigger.at`). For schema-validation
   * issues this is the AJV `instancePath` with leading slash dropped and
   * remaining slashes turned into dots; `recipe` if the issue is at root.
   * Unset for issues whose location is implicit in the message.
   */
  path?: string;
}

/**
 * Validate an ordered route-candidate list (`downshift` / `escalate`): an array
 * of `{driver?, model?}` where each entry sets at least one field and any
 * `driver` is dispatch-known. Shared by both routing fields so they stay in
 * lockstep. Codes are field-prefixed (`downshift-type`, `escalate-type`, …).
 * (quality-aware-escalation)
 */
function validateRouteCandidateList(
  field: "downshift" | "escalate",
  value: unknown,
  stepIndex: number,
  issues: LintIssue[],
): void {
  if (value === undefined) return;
  const base = `steps.${stepIndex}.agent.${field}`;
  if (!Array.isArray(value)) {
    issues.push({
      level: "error",
      message: `Step ${stepIndex + 1}: '${field}' must be an array of {driver?, model?} candidates`,
      code: `${field}-type`,
      path: base,
    });
    return;
  }
  value.forEach((entry: unknown, di: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push({
        level: "error",
        message: `Step ${stepIndex + 1}: ${field}[${di}] must be an object with 'driver' and/or 'model'`,
        code: `${field}-entry-type`,
        path: `${base}.${di}`,
      });
      return;
    }
    const e = entry as Record<string, unknown>;
    const hasDriver = typeof e.driver === "string";
    const hasModel = typeof e.model === "string";
    if (!hasDriver && !hasModel) {
      issues.push({
        level: "error",
        message: `Step ${stepIndex + 1}: ${field}[${di}] must set at least one of 'driver' or 'model'`,
        code: `${field}-entry-empty`,
        path: `${base}.${di}`,
      });
    }
    if (hasDriver && !DOWNSHIFT_KNOWN_DRIVERS.has(e.driver as string)) {
      issues.push({
        level: "error",
        message: `Step ${stepIndex + 1}: ${field}[${di}].driver '${String(e.driver)}' is not a known driver`,
        code: `${field}-driver-enum`,
        path: `${base}.${di}.driver`,
      });
    }
  });
}

export interface LintResult {
  valid: boolean;
  issues: LintIssue[];
  warnings: number;
  errors: number;
}

export function validateRecipeDefinition(recipe: unknown): LintResult {
  const issues: LintIssue[] = [];
  const normalizedRecipe = normalizeRecipeForValidation(recipe);

  if (!normalizedRecipe || typeof normalizedRecipe !== "object") {
    issues.push({ level: "error", message: "Recipe must be a YAML object" });
  } else {
    const r = normalizedRecipe as Record<string, unknown>;

    // Root-level `vars:` is silently dropped at runtime — the runner reads
    // only `trigger.vars` / `trigger.inputs` (PR#259 trap). Warn so the
    // author moves it under `trigger:` instead of debugging empty {{vars}}.
    if (r.vars !== undefined) {
      issues.push({
        level: "warning",
        message:
          "Top-level 'vars' is ignored at runtime — only 'trigger.vars' / 'trigger.inputs' are read. Move declared variables under 'trigger:'.",
        code: "root-vars-ignored",
        path: "vars",
      });
    }

    if (!r.name || typeof r.name !== "string") {
      issues.push({
        level: "error",
        message: "Missing or invalid 'name' field",
      });
    } else if (
      !RECIPE_NAME_RE.test(r.name) &&
      // Registry recipes use scoped `@scope/name` form — accept those
      // the same way the JSON Schema does. Anything else is a real
      // shape error worth flagging.
      !/^@[a-z0-9-]+\/[a-z0-9][a-z0-9-]{0,63}$/.test(r.name)
    ) {
      issues.push({
        level: "warning",
        message:
          "Recipe name should use kebab-case (lowercase letters, numbers, hyphens; max 64 chars; must start with a letter or digit)",
      });
    }

    if (!r.description || typeof r.description !== "string") {
      issues.push({ level: "warning", message: "Missing 'description' field" });
    }

    if (!r.trigger || typeof r.trigger !== "object") {
      issues.push({
        level: "error",
        message: "Missing or invalid 'trigger' field",
      });
    } else {
      const trigger = r.trigger as Record<string, unknown>;
      const validTypes = [
        "manual",
        "cron",
        "webhook",
        "file_watch",
        "git_hook",
        "on_file_save",
        "on_test_run",
        "chained",
      ];
      if (!trigger.type || !validTypes.includes(trigger.type as string)) {
        issues.push({
          level: "error",
          message: `Invalid trigger.type. Must be one of: ${validTypes.join(", ")}`,
        });
      }
      if (trigger.type === "cron" && !trigger.at) {
        issues.push({
          level: "warning",
          message: "cron trigger should have 'at' (cron expression)",
        });
      }
      if (trigger.type === "cron" && typeof trigger.at === "string") {
        // Reject bogus expressions early so users see the error at save
        // time, not when the scheduler silently fails to register the
        // recipe and it never fires. Mirrors the parse path in
        // src/recipes/scheduler.ts:parseSchedule.
        const at = trigger.at.trim();
        const isInterval = /^@every\s+[1-9]\d*\s*(ms|s|m|h)$/i.test(at);
        // Accept 5-field and 6-field cron (M24: node-cron supports 6 fields
        // with a seconds column; reject only if fewer than 5 fields).
        const isCronExpr = /^\S+(?:\s+\S+){4,5}$/.test(at);
        if (!isInterval && !isCronExpr) {
          issues.push({
            level: "error",
            message: `trigger.at "${at}" is not a valid schedule — expected 5- or 6-field cron (e.g. "0 9 * * 1-5") or "@every Ns|Nm|Nh"`,
          });
        } else if (isCronExpr && !cron.validate(at)) {
          // node-cron catches range/step typos a field-count check
          // misses — e.g. "0 25 * * *", "* / 5 * * *".
          issues.push({
            level: "error",
            message: `trigger.at "${at}" is not a valid 5-field cron expression`,
          });
        }
      }

      validateTriggerVarsList(trigger.vars, "vars", issues);
      validateTriggerVarsList(trigger.inputs, "inputs", issues);
    }

    // M26: parallel:{each} map-reduce is not implemented in chained recipes.
    // Check raw recipe.steps (before flattening) so the parallel wrapper is visible.
    const rawRecipe =
      recipe && typeof recipe === "object" && !Array.isArray(recipe)
        ? (recipe as Record<string, unknown>)
        : null;
    const isChainedRecipe =
      rawRecipe?.trigger &&
      typeof rawRecipe.trigger === "object" &&
      !Array.isArray(rawRecipe.trigger) &&
      (rawRecipe.trigger as Record<string, unknown>).type === "chained";
    if (isChainedRecipe && Array.isArray(rawRecipe?.steps)) {
      const rawSteps = rawRecipe!.steps as unknown[];
      for (let i = 0; i < rawSteps.length; i++) {
        const rawStep = rawSteps[i];
        if (rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)) {
          const rs = rawStep as Record<string, unknown>;
          if (
            rs.parallel &&
            typeof rs.parallel === "object" &&
            !Array.isArray(rs.parallel) &&
            "each" in (rs.parallel as Record<string, unknown>)
          ) {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: parallel:{each} map-reduce is not supported in chained recipes. Use the \`fan_out\` tool step for tool-only loops.`,
              path: `steps.${i}.parallel`,
              code: "chained-parallel-each-unsupported",
            });
          }
        }
      }
    }

    if (!Array.isArray(r.steps) || r.steps.length === 0) {
      issues.push({
        level: "error",
        message: "Recipe must have at least one step",
      });
    } else {
      const seenStepIds = new Set<string>();
      for (let i = 0; i < r.steps.length; i++) {
        const step = r.steps[i] as Record<string, unknown>;

        // Duplicate step ids break dependency wiring (`awaits:`, `into:`
        // overwrite, output keying) — the runner keys outputs by id and a
        // second step with the same id silently clobbers the first. Reject.
        if (typeof step.id === "string") {
          if (seenStepIds.has(step.id)) {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: duplicate step id '${step.id}' — step ids must be unique`,
              code: "duplicate-step-id",
              path: `steps.${i}.id`,
            });
          } else {
            seenStepIds.add(step.id);
          }
        }

        const hasTool = typeof step.tool === "string";
        const hasAgent = !!step.agent;
        const hasNestedRecipe =
          typeof step.recipe === "string" || typeof step.chain === "string";

        if (!hasTool && !hasAgent && !hasNestedRecipe) {
          issues.push({
            level: "error",
            message: `Step ${i + 1}: Must have 'tool', 'agent', 'recipe', or 'chain' field`,
          });
        }
        // M31: step-level retry: -1 silently skips tool steps (loop body
        // iterates 0 times when retryCount < 0). Reject at lint time.
        if (step.retry !== undefined) {
          const retryVal = step.retry;
          if (
            typeof retryVal !== "number" ||
            !Number.isInteger(retryVal) ||
            retryVal < 0
          ) {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: retry must be a non-negative integer (got ${JSON.stringify(retryVal)})`,
              path: `steps.${i}.retry`,
            });
          }
        }

        if (step.agent && typeof step.agent === "object") {
          const agent = step.agent as Record<string, unknown>;
          if (!agent.prompt || typeof agent.prompt !== "string") {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: Agent step missing 'prompt'`,
            });
          }

          // Tier-1 #8 (audit 2026-06-22): the judge→refine loop is implemented
          // ONLY in the flat runner. A chained recipe (trigger.type:"chained")
          // treats a `kind: judge` step as a plain agent step and silently
          // ignores `max_revisions` — the refinement never runs. Reject at lint
          // time so users aren't misled into thinking it works here.
          if (isChainedRecipe) {
            const mrChained = agent.max_revisions;
            const judgeRequested =
              agent.kind === "judge" ||
              (typeof mrChained === "number" && mrChained > 0);
            if (judgeRequested) {
              issues.push({
                level: "error",
                message: `Step ${i + 1}: judge→refine (kind: judge / max_revisions) is not supported in chained recipes (trigger.type: chained) — it only runs in the flat runner and would silently no-op here.`,
                code: "chained-judge-unsupported",
                path: `steps.${i}.agent`,
              });
            }
          }

          // `driver: claude|anthropic` routes to the Anthropic API (needs
          // ANTHROPIC_API_KEY), NOT the Claude Code subscription — a common
          // trap. Warn at lint time when the key is absent so the step
          // doesn't silently no-op ("[agent step skipped: ANTHROPIC_API_KEY
          // not set]") at run time. Use `driver: subprocess`/`claude-code`
          // for the subscription path.
          if (
            (agent.driver === "claude" || agent.driver === "anthropic") &&
            !process.env.ANTHROPIC_API_KEY
          ) {
            issues.push({
              level: "warning",
              message: `Step ${i + 1}: driver '${String(agent.driver)}' uses the Anthropic API but ANTHROPIC_API_KEY is not set — the step will be skipped at run time. Set ANTHROPIC_API_KEY, or use 'driver: subprocess' for the Claude Code subscription.`,
              code: "driver-api-key-required",
              path: `steps.${i}.agent.driver`,
            });
          }

          // OPT-IN judge→refine loop fields. Both `max_revisions` and
          // `on_exhausted` are meaningless without a `kind: "judge"` step
          // that points at an upstream step via `reviews:` — a refine loop
          // needs an agent output to re-run. Flag misuse as an error so
          // `recipe lint` / `doctor` catch it before any run.
          const hasRefineField =
            agent.max_revisions !== undefined ||
            agent.on_exhausted !== undefined;
          if (hasRefineField) {
            if (agent.kind !== "judge") {
              issues.push({
                level: "error",
                message: `Step ${i + 1}: 'max_revisions'/'on_exhausted' require 'kind: judge' (the judge→refine loop only applies to judge steps)`,
                code: "refine-requires-judge",
                path: `steps.${i}.agent`,
              });
            } else if (
              typeof agent.reviews !== "string" ||
              agent.reviews.length === 0
            ) {
              issues.push({
                level: "error",
                message: `Step ${i + 1}: 'max_revisions'/'on_exhausted' require 'reviews' to be set (the loop re-runs the reviewed step)`,
                code: "refine-requires-reviews",
                path: `steps.${i}.agent`,
              });
            }
          }
          if (agent.max_revisions !== undefined) {
            const mr = agent.max_revisions;
            if (typeof mr !== "number" || !Number.isInteger(mr) || mr < 0) {
              issues.push({
                level: "error",
                message: `Step ${i + 1}: 'max_revisions' must be a non-negative integer (got ${JSON.stringify(mr)})`,
                code: "refine-max-revisions-invalid",
                path: `steps.${i}.agent.max_revisions`,
              });
            }
          }
          if (
            agent.on_exhausted !== undefined &&
            agent.on_exhausted !== "halt" &&
            agent.on_exhausted !== "proceed"
          ) {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: invalid 'on_exhausted' '${String(agent.on_exhausted)}' — must be 'halt' or 'proceed'`,
              code: "refine-on-exhausted-enum",
              path: `steps.${i}.agent.on_exhausted`,
            });
          }

          // OPT-IN routing fallbacks, both ordered {driver?, model?} lists:
          // `downshift` (cost-aware, Phase 4 — go cheaper as budget depletes)
          // and `escalate` (quality-aware — go more capable on judge rejection).
          validateRouteCandidateList("downshift", agent.downshift, i, issues);
          validateRouteCandidateList("escalate", agent.escalate, i, issues);
        }

        // Unconditional risk-enum check. `risk` was previously never
        // validated here (the parser casts it; the JSON-schema enum is
        // gated behind FLAG_SCHEMA_LINT, which defaults off). A typo like
        // `risk: "hgh"` silently fell through the compiler's risk bucketer
        // to `allow` — fail-open. Flag any out-of-enum value as an error so
        // `recipe lint` / `doctor` catch it before a run. Reads risk from
        // the top-level step AND the nested agent object (both forms occur).
        const stepAgent =
          step.agent && typeof step.agent === "object"
            ? (step.agent as Record<string, unknown>)
            : undefined;
        const riskValue = step.risk ?? stepAgent?.risk;
        if (
          riskValue !== undefined &&
          riskValue !== "low" &&
          riskValue !== "medium" &&
          riskValue !== "high"
        ) {
          issues.push({
            level: "error",
            message: `Step ${i + 1}: invalid risk '${String(riskValue)}' — must be one of: low, medium, high`,
            code: "risk-enum",
            path: `steps.${i}.risk`,
          });
        }
      }

      validateAwaitsTargets(r, recipe, issues);
      validateJudgeReviewsTargets(r, issues);

      validateTemplateReferences(r, issues, collectParallelEachKeys(recipe));
    }

    validateRecipeBudget(r, issues);
    validateRecipeErrorPolicy(r, issues);
  }

  if (isEnabled(FLAG_SCHEMA_LINT)) {
    issues.push(...validateRecipeSchema(normalizedRecipe));
  }

  let errors = 0,
    warnings = 0;
  for (const i of issues) {
    if (i.level === "error") errors++;
    else if (i.level === "warning") warnings++;
  }

  return {
    valid: errors === 0,
    issues,
    warnings,
    errors,
  };
}

/**
 * Validate the optional recipe `budget` block. Closes a real gap: before
 * cost-routing Phase 3 there was NO budget validation, so `tokensMax: -5` or
 * `tokensMax: "lots"` passed lint silently. A present cap must be a positive
 * number; `onBreach` must be the halt|warn enum.
 */
function validateRecipeBudget(
  r: Record<string, unknown>,
  issues: LintIssue[],
): void {
  const budget = r.budget;
  if (budget === undefined) return;
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
    issues.push({
      level: "error",
      message: "'budget' must be an object",
      path: "budget",
      code: "budget-type",
    });
    return;
  }
  const b = budget as Record<string, unknown>;
  for (const key of ["tokensMax", "usdMax"] as const) {
    const value = b[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !(value > 0)) {
      issues.push({
        level: "error",
        message: `budget.${key} must be a positive number`,
        path: `budget.${key}`,
        code: "budget-positive",
      });
    }
  }
  if (
    b.onBreach !== undefined &&
    b.onBreach !== "halt" &&
    b.onBreach !== "warn"
  ) {
    issues.push({
      level: "error",
      message: "budget.onBreach must be 'halt' or 'warn'",
      path: "budget.onBreach",
      code: "budget-onbreach-enum",
    });
  }
  if (
    b.estimateUnmeasured !== undefined &&
    typeof b.estimateUnmeasured !== "boolean"
  ) {
    issues.push({
      level: "error",
      message: "budget.estimateUnmeasured must be a boolean",
      path: "budget.estimateUnmeasured",
      code: "budget-estimate-type",
    });
  }
}

/**
 * Validate the optional recipe `on_error` policy block. Audit 2026-06-03
 * (MEDIUM): the hand-rolled lint never checked it, so a typo'd `fallback`
 * enum, a non-numeric `retry`, or a negative `retry` (which the runtime
 * now clamps — see chainedRunner.withRetry, audit HIGH #8) passed lint
 * silently. Mirrors validateRecipeBudget. `retry` is a non-negative integer;
 * `retryDelay` a non-negative number (ms); `fallback` the documented enum.
 */
function validateRecipeErrorPolicy(
  r: Record<string, unknown>,
  issues: LintIssue[],
): void {
  const onError = r.on_error;
  if (onError === undefined) return;
  if (
    typeof onError !== "object" ||
    onError === null ||
    Array.isArray(onError)
  ) {
    issues.push({
      level: "error",
      message: "'on_error' must be an object",
      path: "on_error",
      code: "on-error-type",
    });
    return;
  }
  const e = onError as Record<string, unknown>;
  if (e.retry !== undefined) {
    if (
      typeof e.retry !== "number" ||
      !Number.isInteger(e.retry) ||
      e.retry < 0
    ) {
      issues.push({
        level: "error",
        message: "on_error.retry must be a non-negative integer",
        path: "on_error.retry",
        code: "on-error-retry",
      });
    }
  }
  if (e.retryDelay !== undefined) {
    if (
      typeof e.retryDelay !== "number" ||
      !Number.isFinite(e.retryDelay) ||
      e.retryDelay < 0
    ) {
      issues.push({
        level: "error",
        message: "on_error.retryDelay must be a non-negative number (ms)",
        path: "on_error.retryDelay",
        code: "on-error-retrydelay",
      });
    }
  }
  if (
    e.fallback !== undefined &&
    e.fallback !== "log_only" &&
    e.fallback !== "abort" &&
    e.fallback !== "deliver_original"
  ) {
    issues.push({
      level: "error",
      message:
        "on_error.fallback must be 'log_only', 'abort', or 'deliver_original'",
      path: "on_error.fallback",
      code: "on-error-fallback-enum",
    });
  }
}

/**
 * Validate step `awaits:` targets against the set of declared step ids.
 *
 * An `awaits:` target that matches no real step is a recipe-authoring bug
 * that the runtime can't recover from: the cycle-detection DFS skips the
 * phantom edge (so `hasCycles` stays false), but Kahn's algorithm counts it
 * in the awaiting step's in-degree and never decrements it — so the
 * awaiting step AND all its transitive dependents silently drop out of the
 * topological order, never run, and the run STILL reports success. Flag it
 * statically so `recipe lint` / `doctor` catch it before any run.
 *
 * Known-id collection runs over BOTH:
 *   - the NORMALIZED recipe (`normalizedRecipe.steps`) — `awaits:` clauses
 *     live here, and `flattenValidationSteps` has already hoisted parallel
 *     children to top level (so child ids are present), AND
 *   - the RAW recipe (`rawRecipe.steps`) — still carries the `parallel:`
 *     CONTAINER ids that flattening drops.
 *
 * The union matters because `awaits: [<parallel-group-id>]` is VALID at
 * runtime: `chainedRunner.expandParallelSteps` rewrites a group-id await to
 * the expanded child ids. Collecting from the raw steps keeps those
 * container ids in `knownIds` so a legitimate group-await isn't flagged,
 * while a genuine typo (`gather2`) — present in neither list — still errors.
 */
/**
 * Cross-check each judge step's `reviews:` target against the set of resolvable
 * step keys. The runtime resolves `reviews` against ctx (keyed by `into`) first,
 * then falls back to step `id` — a reference matching neither silently reviews
 * nothing. Flag as error when a refine loop is configured (max_revisions set),
 * warning otherwise (the judge still runs; it just has no prior output to review).
 */
function validateJudgeReviewsTargets(
  r: Record<string, unknown>,
  issues: LintIssue[],
): void {
  const steps = Array.isArray(r.steps)
    ? (r.steps as Array<Record<string, unknown>>)
    : [];

  // Collect all resolvable keys: every step's `into` value + every step `id`.
  const resolvable = new Set<string>();
  for (const step of steps) {
    const agent =
      step.agent && typeof step.agent === "object"
        ? (step.agent as Record<string, unknown>)
        : undefined;
    if (typeof agent?.into === "string") resolvable.add(agent.into);
    if (typeof step.id === "string") resolvable.add(step.id);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const agent =
      step.agent && typeof step.agent === "object"
        ? (step.agent as Record<string, unknown>)
        : undefined;
    if (!agent || agent.kind !== "judge") continue;
    const reviews = agent.reviews;
    if (typeof reviews !== "string" || reviews.length === 0) continue;
    if (resolvable.has(reviews)) continue;
    const hasRefineLoop =
      agent.max_revisions !== undefined || agent.on_exhausted !== undefined;
    issues.push({
      level: hasRefineLoop ? "error" : "warning",
      message: `Step ${i + 1}: 'reviews: ${reviews}' does not match any step into key or step id — the judge would review nothing at run time`,
      code: "judge-reviews-unresolved",
      path: `steps.${i}.agent.reviews`,
    });
  }
}

function validateAwaitsTargets(
  normalizedRecipe: Record<string, unknown>,
  rawRecipe: unknown,
  issues: LintIssue[],
): void {
  const steps = Array.isArray(normalizedRecipe.steps)
    ? (normalizedRecipe.steps as Array<Record<string, unknown>>)
    : [];
  if (steps.length === 0) return;

  const knownIds = new Set<string>();
  const collectIds = (list: Array<Record<string, unknown>>): void => {
    for (const step of list) {
      if (!step || typeof step !== "object") continue;
      if (typeof step.id === "string") knownIds.add(step.id);
      if (Array.isArray(step.parallel)) {
        collectIds(step.parallel as Array<Record<string, unknown>>);
      } else if (
        step.parallel &&
        typeof step.parallel === "object" &&
        Array.isArray((step.parallel as Record<string, unknown>).steps)
      ) {
        collectIds(
          (step.parallel as Record<string, unknown>).steps as Array<
            Record<string, unknown>
          >,
        );
      }
    }
  };
  // Collect from the flattened (normalized) list first — child ids + any
  // top-level ids.
  collectIds(steps);
  // Then collect from the RAW recipe steps so parallel-group CONTAINER ids
  // (which `flattenValidationSteps` strips) are recognised as valid await
  // targets. `collectIds` recurses into `parallel:` arrays / map-reduce
  // `{steps}` blocks, picking up both the container id and its children.
  if (
    rawRecipe &&
    typeof rawRecipe === "object" &&
    !Array.isArray(rawRecipe) &&
    Array.isArray((rawRecipe as Record<string, unknown>).steps)
  ) {
    collectIds(
      (rawRecipe as Record<string, unknown>).steps as Array<
        Record<string, unknown>
      >,
    );
  }

  const checkAwaits = (
    list: Array<Record<string, unknown>>,
    label: (i: number) => string,
  ): void => {
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      if (!step || typeof step !== "object") continue;
      if (Array.isArray(step.awaits)) {
        for (const target of step.awaits) {
          if (typeof target === "string" && !knownIds.has(target)) {
            issues.push({
              level: "error",
              message: `${label(i)}: awaits unknown step '${target}' — no step with that id exists. The step (and everything depending on it) would silently never run.`,
              code: "unknown-awaits-target",
              path: `steps.${i}.awaits`,
            });
          }
        }
      }
      if (Array.isArray(step.parallel)) {
        checkAwaits(
          step.parallel as Array<Record<string, unknown>>,
          (j) => `${label(i)}.parallel[${j}]`,
        );
      } else if (
        step.parallel &&
        typeof step.parallel === "object" &&
        Array.isArray((step.parallel as Record<string, unknown>).steps)
      ) {
        checkAwaits(
          (step.parallel as Record<string, unknown>).steps as Array<
            Record<string, unknown>
          >,
          (j) => `${label(i)}.parallel.steps[${j}]`,
        );
      }
    }
  };
  checkAwaits(steps, (i) => `Step ${i + 1}`);
}

/**
 * Validate `trigger.vars` / `trigger.inputs` array entries. Catches names
 * the runtime template engine can't resolve as `{{var}}` (e.g. spaces,
 * dots, leading digits) and shadowing of built-in context keys
 * (`payload`, `file`, `hash`, `date`, etc.). Both classes save HTTP 200
 * silently today and only blow up at run time.
 */
function validateTriggerVarsList(
  list: unknown,
  fieldName: "vars" | "inputs",
  issues: LintIssue[],
): void {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({
        level: "error",
        message: `trigger.${fieldName}[${i}] must be an object with at least a 'name' field`,
      });
      continue;
    }
    const name = (entry as Record<string, unknown>).name;
    if (typeof name !== "string" || name.length === 0) {
      issues.push({
        level: "error",
        message: `trigger.${fieldName}[${i}].name is required and must be a non-empty string`,
      });
      continue;
    }
    if (!RECIPE_VAR_NAME_RE.test(name)) {
      issues.push({
        level: "error",
        message: `trigger.${fieldName}[${i}].name "${name}" is invalid — must start with a letter or underscore, then letters, digits, or underscores only (max 64 chars). Names not matching this can never resolve as {{${name}}} at runtime.`,
      });
      continue;
    }
    // Case-insensitive — `RECIPE_VAR_NAME_RE` admits `DATE`/`Date` but
    // the reserved set is lowercase. Future-proof the gate against
    // contributors flipping the renderer to case-insensitive lookups.
    if (RESERVED_VAR_NAMES.has(name.toLowerCase())) {
      issues.push({
        level: "error",
        message: `trigger.${fieldName}[${i}].name "${name}" shadows a reserved built-in context key — pick a different name`,
      });
    }
  }
}

function normalizeRecipeForValidation(recipe: unknown): unknown {
  const normalized = normalizeRecipeForRuntime(recipe, defaultDeprecationWarn);

  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return normalized;
  }

  const validationReady: Record<string, unknown> = {
    ...(normalized as Record<string, unknown>),
  };

  if (
    validationReady.trigger &&
    typeof validationReady.trigger === "object" &&
    !Array.isArray(validationReady.trigger)
  ) {
    validationReady.trigger = normalizeValidationTrigger(
      validationReady.trigger as Record<string, unknown>,
    );
  }

  if (Array.isArray(validationReady.steps)) {
    validationReady.steps = flattenValidationSteps(validationReady.steps);
  }

  return validationReady;
}

function normalizeValidationTrigger(
  trigger: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...trigger };

  if (normalized.type === "event") {
    normalized.type = "webhook";
    normalized.legacyType = "event";

    if (typeof normalized.on === "string") {
      normalized.eventSource = normalized.on;
    }
    delete normalized.on;

    if (
      normalized.filter !== undefined &&
      typeof normalized.filter !== "string"
    ) {
      normalized.eventFilter = normalized.filter;
      delete normalized.filter;
    }

    if (normalized.lead_time_hours !== undefined) {
      normalized.eventLeadTimeHours = normalized.lead_time_hours;
      delete normalized.lead_time_hours;
    }

    if (normalized.lead_time_minutes !== undefined) {
      normalized.eventLeadTimeMinutes = normalized.lead_time_minutes;
      delete normalized.lead_time_minutes;
    }
  }

  return normalized;
}

function flattenValidationSteps(steps: unknown[]): unknown[] {
  const normalizedSteps: unknown[] = [];
  for (const step of steps) {
    normalizedSteps.push(...flattenValidationStep(step));
  }
  return normalizedSteps;
}

function flattenValidationStep(step: unknown): unknown[] {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return [step];
  }

  const record = step as Record<string, unknown>;

  if (Array.isArray(record.parallel)) {
    const parallelSteps: unknown[] = [];
    for (const nestedStep of record.parallel) {
      parallelSteps.push(...flattenValidationStep(nestedStep));
    }
    return parallelSteps;
  }

  // parallel: { each: ..., as: ..., steps: [...] } — map-reduce syntax
  if (
    record.parallel &&
    typeof record.parallel === "object" &&
    !Array.isArray(record.parallel)
  ) {
    const mapReduce = record.parallel as Record<string, unknown>;
    if (Array.isArray(mapReduce.steps)) {
      const parallelSteps: unknown[] = [];
      for (const nestedStep of mapReduce.steps) {
        parallelSteps.push(...flattenValidationStep(nestedStep));
      }
      return parallelSteps;
    }
  }

  if (Array.isArray(record.branch)) {
    const branchSteps: unknown[] = [];
    for (const branchStep of record.branch) {
      if (
        !branchStep ||
        typeof branchStep !== "object" ||
        Array.isArray(branchStep)
      ) {
        continue;
      }

      const branchRecord = branchStep as Record<string, unknown>;
      const otherwiseStep = branchRecord.otherwise;
      if (
        otherwiseStep &&
        typeof otherwiseStep === "object" &&
        !Array.isArray(otherwiseStep)
      ) {
        // Validate the `otherwise` block.
        branchSteps.push(...flattenValidationStep(otherwiseStep));
        // Also validate the co-located conditional step fields (if any) — strip
        // `otherwise` so the validator sees only the branch-step shape.
        // Only do this when the entry has keys beyond `otherwise`; a standalone
        // `{ otherwise: {...} }` entry has nothing else to validate and passing
        // an empty object `{}` to the schema validator produces bogus errors.
        const { otherwise: _omit, ...branchWithoutOtherwise } = branchRecord;
        if (Object.keys(branchWithoutOtherwise).length > 0) {
          branchSteps.push(...flattenValidationStep(branchWithoutOtherwise));
        }
        continue;
      }

      branchSteps.push(...flattenValidationStep(branchRecord));
    }

    return branchSteps.length > 0 ? branchSteps : [record];
  }

  return [record];
}

// Cached compiled validator — schema is deterministic per process lifetime.
// generateSchemaSet() + ajv.compile() together take ~100-500ms depending on
// machine speed; recompiling per call makes the lint test suite O(n * compile)
// when it should be O(1 compile + n validate).
let _cachedValidate: ValidateFunction | null = null;

function getRecipeValidator(): ValidateFunction {
  if (_cachedValidate) return _cachedValidate;
  const schemas = generateSchemaSet();
  const ajv = createAjv2020({ strict: false, allErrors: true });
  for (const schema of Object.values(schemas.namespaces)) {
    ajv.addSchema(schema as object);
  }
  _cachedValidate = ajv.compile(schemas.recipe as object);
  return _cachedValidate;
}

function validateRecipeSchema(recipe: unknown): LintIssue[] {
  try {
    const validate = getRecipeValidator();
    const valid = validate(recipe);
    if (valid) {
      return [];
    }

    return (validate.errors ?? []).map(toSchemaLintIssue);
  } catch (err) {
    return [
      {
        level: "error",
        message: `Schema validation failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

function registerRecipeContextKeys(
  recipe: Record<string, unknown>,
  availableKeys: Set<string>,
): void {
  const trigger =
    recipe.trigger && typeof recipe.trigger === "object"
      ? (recipe.trigger as Record<string, unknown>)
      : undefined;

  if (trigger?.type === "git_hook") {
    availableKeys.add("hash");
    availableKeys.add("message");
    availableKeys.add("branch");
  }

  // Webhook triggers: the seed context the bridge passes to the runner
  // (recipeOrchestration.ts:290-296) sets these four keys. `payload` is the
  // raw JSON body (or stringified non-JSON), accessible via dotted paths
  // (e.g. `{{payload.text}}`) — the renderer JSON-parses string
  // intermediates on the fly (yamlRunner.ts:870-878).
  if (trigger?.type === "webhook") {
    availableKeys.add("payload");
    availableKeys.add("webhook_payload");
    availableKeys.add("hook_path");
    availableKeys.add("webhook_path");
  }

  if (trigger?.type === "on_file_save" || trigger?.type === "file_watch") {
    availableKeys.add("file");
    availableKeys.add("file_ext");
    availableKeys.add("file_basename");
  }

  if (trigger?.type === "on_test_run") {
    availableKeys.add("runner");
    availableKeys.add("failed");
    availableKeys.add("passed");
    availableKeys.add("total");
    availableKeys.add("failures");
  }

  if (trigger?.legacyType === "event") {
    availableKeys.add("event");
  }

  if (Array.isArray(trigger?.vars)) {
    for (const item of trigger.vars) {
      if (item && typeof item === "object" && typeof item.name === "string") {
        availableKeys.add(item.name);
      }
    }
  }

  if (Array.isArray(trigger?.inputs)) {
    for (const item of trigger.inputs) {
      if (item && typeof item === "object" && typeof item.name === "string") {
        availableKeys.add(item.name);
      }
    }
  }

  if (Array.isArray(recipe.context)) {
    for (const block of recipe.context) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === "env" && Array.isArray(typedBlock.keys)) {
        for (const key of typedBlock.keys) {
          if (typeof key === "string") {
            availableKeys.add(key);
          }
        }
      }
    }
  }
}

function toSchemaLintIssue(error: ErrorObject): LintIssue {
  const path = error.instancePath
    ? error.instancePath.slice(1).replace(/\//g, ".")
    : "recipe";
  return {
    level: "error",
    message: `Schema validation: ${path} ${error.message ?? "is invalid"}`,
    code: error.keyword,
    path,
  };
}

function collectParallelEachKeys(recipe: unknown): Set<string> {
  const keys = new Set<string>();
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe))
    return keys;
  const steps = (recipe as Record<string, unknown>).steps;
  collectParallelEachKeysFromSteps(steps, keys);
  return keys;
}

/**
 * Walk a steps array, collecting parallel-each loop variable keys. Recurses
 * into `parallel: [...]` group arrays so a nested map-reduce step inside a
 * parallel group still contributes its loop variable (`as`) — otherwise
 * `{{item}}` references in those child steps were flagged as unknown template
 * references, blocking valid recipes (audit 2026-06-10 recipe-validation-4).
 */
function collectParallelEachKeysFromSteps(
  steps: unknown,
  keys: Set<string>,
): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const s = step as Record<string, unknown>;
    if (Array.isArray(s.parallel)) {
      // Parallel GROUP array — recurse into its child steps.
      collectParallelEachKeysFromSteps(s.parallel, keys);
    } else if (s.parallel && typeof s.parallel === "object") {
      // Parallel map-reduce (each/as) object.
      const par = s.parallel as Record<string, unknown>;
      if (typeof par.as === "string") keys.add(par.as);
      if (typeof s.id === "string") {
        keys.add(s.id);
        keys.add(`${s.id}.results`);
      }
      // Recurse into the map-reduce body so deeper nesting is also covered.
      collectParallelEachKeysFromSteps(par.steps, keys);
    }
    // Step-level each: "{{items}}" as: item — loop variable
    if (typeof s.as === "string") keys.add(s.as);
  }
}

function validateTemplateReferences(
  recipe: Record<string, unknown>,
  issues: LintIssue[],
  extraParallelKeys?: Set<string>,
): void {
  const builtinKeys = new Set<string>([
    // Date/time tokens injected at runtime: `date`/`time` on the flat path and
    // `DATE`/`TIME` on the chained dispatch path, plus the YYYY / YYYY-MM /
    // YYYY-MM-DD / ISO_NOW / HH / MM / SS family — now injected on BOTH paths
    // (yamlRunner.ts ctx + dispatchRecipe env), so {{YYYY-MM-DD}} etc. render
    // real values AND pass lint. Keep in sync with the yamlRunner.ts injection
    // sites. (audit 2026-06-10 recipe-validation-1)
    "date",
    "time",
    "DATE",
    "TIME",
    "YYYY",
    "YYYY-MM",
    "YYYY-MM-DD",
    "ISO_NOW",
    "HH",
    "MM",
    "SS",
    "this", // Handlebars loop current-item reference
  ]);
  const availableKeys = new Set<string>(builtinKeys);
  registerRecipeContextKeys(recipe, availableKeys);
  if (extraParallelKeys) {
    for (const k of extraParallelKeys) availableKeys.add(k);
  }
  const triggerType =
    recipe.trigger && typeof recipe.trigger === "object"
      ? (recipe.trigger as Record<string, unknown>).type
      : undefined;
  const isChainedRecipe = triggerType === "chained";
  const steps = Array.isArray(recipe.steps)
    ? (recipe.steps as Array<Record<string, unknown>>)
    : [];
  const seenIntoKeys = new Map<string, number>();
  // Per-into output-schema index for tools with a registered outputSchema.
  // Allows static validation of dotted refs like {{messages.threads}} against
  // the keys actually exposed by the runtime context-flattener.
  const outputSchemaIndex = new Map<
    string,
    { toolId: string; allowedKeys: Set<string> }
  >();

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] ?? {};
    const templates = collectRenderedTemplates(step, isChainedRecipe);

    for (const template of templates) {
      const scopedKeys = template.extraKeys
        ? new Set([...availableKeys, ...template.extraKeys])
        : availableKeys;
      for (const expression of extractTemplateExpressions(template.value)) {
        const refs = extractTemplateDottedPaths(expression);
        let rootError = false;
        for (const { root } of refs) {
          if (!scopedKeys.has(root)) {
            issues.push({
              level: "error",
              message: `Step ${index + 1}: Unknown template reference '{{${expression}}}' in ${template.label}`,
            });
            rootError = true;
            break;
          }
        }
        if (rootError) {
          continue;
        }
        for (const { root, full } of refs) {
          if (full === root) continue;
          const schema = outputSchemaIndex.get(root);
          if (!schema) continue;
          if (schema.allowedKeys.has(full)) continue;
          issues.push({
            level: "warning",
            message: `Step ${index + 1}: Template reference '{{${full}}}' in ${template.label} is not exposed by tool '${schema.toolId}' output schema (allowed: ${formatAllowedKeys(schema.allowedKeys)})`,
          });
        }
      }
    }

    const intoKey = resolveStepIntoKey(step, isChainedRecipe);
    if (intoKey) {
      if (builtinKeys.has(intoKey)) {
        issues.push({
          level: "error",
          message: `Step ${index + 1}: 'into: ${intoKey}' shadows a built-in context key`,
        });
      } else {
        const firstSeen = seenIntoKeys.get(intoKey);
        if (firstSeen !== undefined) {
          issues.push({
            level: "warning",
            message: `Step ${index + 1}: 'into: ${intoKey}' overwrites value already written by step ${firstSeen}`,
          });
        } else {
          seenIntoKeys.set(intoKey, index + 1);
        }
      }
    }

    registerStepContextKeys(step, availableKeys, outputSchemaIndex);
  }
}

function collectRenderedTemplates(
  step: Record<string, unknown>,
  isChainedRecipe: boolean,
): Array<{ label: string; value: string; extraKeys?: Set<string> }> {
  const templates: Array<{
    label: string;
    value: string;
    extraKeys?: Set<string>;
  }> = [];
  // transform: renders with $result injected (raw tool output); any key under
  // $result.* is resolved at runtime and cannot be statically validated.
  const transformExtraKeys = new Set<string>(["$result"]);

  for (const [key, value] of Object.entries(step)) {
    if (key === "tool" || key === "into" || key === "agent") {
      continue;
    }
    if (typeof value === "string") {
      if (key === "transform") {
        templates.push({ label: key, value, extraKeys: transformExtraKeys });
      } else {
        templates.push({ label: key, value });
      }
    }
  }

  if (step.agent && typeof step.agent === "object") {
    const agent = step.agent as Record<string, unknown>;
    if (typeof agent.prompt === "string") {
      templates.push({ label: "agent.prompt", value: agent.prompt });
    }
  }

  if (isChainedRecipe && step.vars && typeof step.vars === "object") {
    for (const [key, value] of Object.entries(
      step.vars as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        templates.push({ label: `vars.${key}`, value });
      }
    }
  }

  return templates;
}

function extractTemplateExpressions(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g);
  const expressions: string[] = [];
  for (const match of matches) {
    const expression = match[1]?.trim();
    if (!expression) continue;
    // Skip Handlebars block helpers: {{#if}}, {{/each}}, {{else}}, etc.
    if (
      expression.startsWith("#") ||
      expression.startsWith("/") ||
      expression === "else"
    )
      continue;
    // Skip function-call expressions like file_read(PATH) — runtime-evaluated.
    if (expression.includes("(")) continue;
    expressions.push(expression);
  }
  return expressions;
}

function extractTemplateDottedPaths(
  expression: string,
): Array<{ root: string; full: string }> {
  // Strip Jinja-style filters (e.g. "| slug") — identifiers after | are filter
  // names, not variable references, so should not be resolved against context.
  const stripped = expression.replace(/\|[^|]*/g, "");
  const reserved = new Set(["true", "false", "null"]);
  const paths: Array<{ root: string; full: string }> = [];
  const seen = new Set<string>();

  for (const match of stripped.matchAll(
    /\$?[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/g,
  )) {
    const fullPath = match[0];
    if (!fullPath || seen.has(fullPath)) {
      continue;
    }
    const root = fullPath.split(".")[0] ?? fullPath;
    if (reserved.has(root)) {
      continue;
    }
    seen.add(fullPath);
    paths.push({ root, full: fullPath });
  }

  return paths;
}

function formatAllowedKeys(keys: Set<string>): string {
  if (keys.size === 0) return "(none)";
  return Array.from(keys).sort().join(", ");
}

function registerStepContextKeys(
  step: Record<string, unknown>,
  availableKeys: Set<string>,
  outputSchemaIndex?: Map<string, { toolId: string; allowedKeys: Set<string> }>,
): void {
  const stepId = typeof step.id === "string" ? step.id : undefined;
  if (stepId) {
    availableKeys.add(stepId);
  }

  if (step.agent && typeof step.agent === "object") {
    const agent = step.agent as Record<string, unknown>;
    const intoKey =
      typeof agent.into === "string" ? agent.into : "agent_output";
    availableKeys.add(intoKey);
    return;
  }

  const intoKey = typeof step.into === "string" ? step.into : undefined;
  if (!intoKey) {
    return;
  }

  availableKeys.add(intoKey);

  const toolId = typeof step.tool === "string" ? step.tool : undefined;
  if (!toolId) {
    return;
  }

  const flattenedKeys = listToolOutputContextKeys(toolId, intoKey);
  for (const key of flattenedKeys) {
    availableKeys.add(key);
  }

  // Only register a schema entry for tools that actually expose flattened
  // dotted keys; otherwise we have nothing to validate against and would
  // produce false positives for tools without an outputSchema.
  if (outputSchemaIndex && flattenedKeys.length > 0) {
    const allowedKeys = new Set<string>([intoKey, ...flattenedKeys]);
    outputSchemaIndex.set(intoKey, { toolId, allowedKeys });
  }
}

function resolveStepIntoKey(
  step: Record<string, unknown>,
  isChainedRecipe: boolean,
): string | null {
  if (step.agent && typeof step.agent === "object") {
    const agent = step.agent as Record<string, unknown>;
    return typeof agent.into === "string" ? agent.into : "agent_output";
  }
  if (typeof step.into === "string") return step.into;
  if (isChainedRecipe && typeof step.id === "string") return step.id;
  return null;
}
