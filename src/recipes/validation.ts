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

export interface LintIssue {
  level: "error" | "warning";
  message: string;
  /** 1-indexed line in the source YAML, when available (populated in a later phase). */
  line?: number;
  /** 1-indexed column in the source YAML, when available. */
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
        const isCron5 = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(at);
        if (!isInterval && !isCron5) {
          issues.push({
            level: "error",
            message: `trigger.at "${at}" is not a valid schedule — expected 5-field cron (e.g. "0 9 * * 1-5") or "@every Ns|Nm|Nh"`,
          });
        } else if (isCron5 && !cron.validate(at)) {
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

    if (!Array.isArray(r.steps) || r.steps.length === 0) {
      issues.push({
        level: "error",
        message: "Recipe must have at least one step",
      });
    } else {
      for (let i = 0; i < r.steps.length; i++) {
        const step = r.steps[i] as Record<string, unknown>;
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
        if (step.agent && typeof step.agent === "object") {
          const agent = step.agent as Record<string, unknown>;
          if (!agent.prompt || typeof agent.prompt !== "string") {
            issues.push({
              level: "error",
              message: `Step ${i + 1}: Agent step missing 'prompt'`,
            });
          }
        }
      }

      validateTemplateReferences(r, issues, collectParallelEachKeys(recipe));
    }
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
        branchSteps.push(...flattenValidationStep(otherwiseStep));
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
  if (!Array.isArray(steps)) return keys;
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const s = step as Record<string, unknown>;
    if (
      s.parallel &&
      typeof s.parallel === "object" &&
      !Array.isArray(s.parallel)
    ) {
      const par = s.parallel as Record<string, unknown>;
      if (typeof par.as === "string") keys.add(par.as);
      if (typeof s.id === "string") {
        keys.add(s.id);
        keys.add(`${s.id}.results`);
      }
    }
    // Step-level each: "{{items}}" as: item — loop variable
    if (typeof s.as === "string") keys.add(s.as);
  }
  return keys;
}

function validateTemplateReferences(
  recipe: Record<string, unknown>,
  issues: LintIssue[],
  extraParallelKeys?: Set<string>,
): void {
  const builtinKeys = new Set<string>([
    "date",
    "time",
    "YYYY",
    "YYYY-MM",
    "YYYY-MM-DD",
    "ISO_NOW",
    "HH", // time component in datetime format strings
    "MM", // time component in datetime format strings
    "SS", // time component in datetime format strings
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
