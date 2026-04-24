/**
 * Recipe CLI commands — new, lint, test, watch, record, fmt
 *
 * Implements the A2 CLI UX milestone for recipe authoring.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import "../recipes/tools/index.js";
import { loadFixtureLibrary } from "../connectors/fixtureLibrary.js";
import { MockConnector } from "../connectors/mockConnector.js";
import { normalizeRecipeForRuntime } from "../recipes/legacyRecipeCompat.js";
import { generateSchemaSet, writeSchemas } from "../recipes/schemaGenerator.js";
import {
  getTool,
  isConnectorNamespace,
  seedToolOutputPreviewContext,
} from "../recipes/toolRegistry.js";
import {
  type LintIssue,
  type LintResult,
  validateRecipeDefinition,
} from "../recipes/validation.js";
import {
  buildChainedDeps,
  dispatchRecipe,
  loadYamlRecipe,
  type MockToolConnector,
  type RunnerDeps,
  type RunResult,
  render,
  runYamlRecipe,
  type YamlRecipe,
  type YamlStep,
} from "../recipes/yamlRunner.js";
import { findYamlRecipePath } from "../recipesHttp.js";

const RECIPES_DIR = join(os.homedir(), ".patchwork", "recipes");
const FIXTURES_DIR = join(os.homedir(), ".patchwork", "fixtures");
const RECIPE_SCHEMA_HEADER =
  "# yaml-language-server: $schema=https://patchworkos.com/schema/recipe.v1.json";
const RECIPE_API_VERSION = "patchwork.sh/v1";

// ============================================================================
// patchwork recipe new
// ============================================================================

const TEMPLATES: Record<string, string> = {
  minimal: `apiVersion: ${RECIPE_API_VERSION}
name: {{name}}
description: {{description}}
trigger:
  type: manual
steps:
  - tool: file.write
    path: ~/.patchwork/inbox/{{name}}.md
    content: "Hello from {{name}}\\n"
`,
  daily: `apiVersion: ${RECIPE_API_VERSION}
name: {{name}}
description: {{description}}
trigger:
  type: cron
  at: "0 9 * * 1-5"
steps:
  - tool: git.log_since
    since: "24h"
    into: commits
  - agent:
      prompt: |
        Summarize these commits for a daily standup:
        {{commits}}
      into: summary
  - tool: file.write
    path: ~/.patchwork/inbox/{{name}}-{{date}}.md
    content: "# {{name}}\\n\\n{{summary}}\\n"
`,
  inbox: `apiVersion: ${RECIPE_API_VERSION}
name: {{name}}
description: {{description}}
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: "24h"
    max: 20
    into: unread
  - tool: github.list_issues
    assignee: "@me"
    max: 10
    into: issues
  - agent:
      prompt: |
        Summarize my inbox. Unread emails: {{unread}}.
        Assigned issues: {{issues}}.
      into: summary
  - tool: file.write
    path: ~/.patchwork/inbox/{{name}}-{{date}}.md
    content: "# {{name}}\\n\\n{{summary}}\\n"
`,
};

export interface NewOptions {
  name: string;
  description: string;
  template?: string;
  outputDir?: string;
}

export function runNew(options: NewOptions): { path: string; content: string } {
  if (!options.name) {
    throw new Error("Recipe name is required");
  }
  if (!options.description) {
    throw new Error("Recipe description is required");
  }

  const templateKey = options.template ?? "minimal";
  const template = TEMPLATES[templateKey];

  if (!template) {
    throw new Error(
      `Unknown template: "${templateKey}". ` +
        `Available: ${Object.keys(TEMPLATES).join(", ")}`,
    );
  }

  const today = new Date().toISOString().split("T")[0] ?? "";
  const body = template
    .replace(/\{\{name\}\}/g, options.name)
    .replace(/\{\{description\}\}/g, options.description)
    .replace(/\{\{date\}\}/g, today);
  const content = `${RECIPE_SCHEMA_HEADER}\n${body}`;

  const outputDir = options.outputDir ?? RECIPES_DIR;
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, `${options.name}.yaml`);

  if (existsSync(outputPath)) {
    throw new Error(`Recipe already exists: ${outputPath}`);
  }

  writeFileSync(outputPath, content);

  return { path: outputPath, content };
}

export function listTemplates(): string[] {
  return Object.keys(TEMPLATES);
}

export interface SchemaWriteResult {
  outputDir: string;
  filesWritten: string[];
}

export async function runSchema(outputDir: string): Promise<SchemaWriteResult> {
  const resolvedOutputDir = resolve(outputDir);
  const schemas = generateSchemaSet();
  const filesWritten: string[] = [];

  await writeSchemas(resolvedOutputDir, schemas, (filePath, content) => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content);
    filesWritten.push(filePath);
  });

  return {
    outputDir: resolvedOutputDir,
    filesWritten,
  };
}

// ============================================================================
// patchwork recipe lint
// ============================================================================

export type { LintIssue, LintResult };

/**
 * Lint a recipe file against the schema.
 * Falls back to basic YAML parsing if schema linting is disabled.
 */
export function runLint(recipePath: string): LintResult {
  // Check file exists
  if (!existsSync(recipePath)) {
    return {
      valid: false,
      issues: [{ level: "error", message: `File not found: ${recipePath}` }],
      warnings: 0,
      errors: 1,
    };
  }

  let content: string;
  try {
    content = readFileSync(recipePath, "utf-8");
  } catch (err) {
    return {
      valid: false,
      issues: [
        {
          level: "error",
          message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      warnings: 0,
      errors: 1,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return {
      valid: false,
      issues: [
        {
          level: "error",
          message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      warnings: 0,
      errors: 1,
    };
  }

  const result = validateRecipeDefinition(parsed);

  // For chained recipes, check that chain: file references resolve on disk.
  const chainIssues = lintChainRefs(parsed, recipePath);
  if (chainIssues.length > 0) {
    result.issues.push(...chainIssues);
    result.errors += chainIssues.filter((i) => i.level === "error").length;
    result.warnings += chainIssues.filter((i) => i.level === "warning").length;
    if (result.errors > 0) {
      (result as { valid: boolean }).valid = false;
    }
  }

  return result;
}

/**
 * Walk chained recipe steps, check that chain:/recipe: refs resolve on disk,
 * and recursively lint any child recipe that does resolve.
 *
 * `visited` tracks absolute paths already linted in this call chain to prevent
 * infinite recursion when two recipes chain each other.
 */
function lintChainRefs(
  parsed: unknown,
  recipePath: string,
  visited: Set<string> = new Set(),
): LintIssue[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const r = parsed as Record<string, unknown>;

  const trigger =
    r.trigger && typeof r.trigger === "object"
      ? (r.trigger as Record<string, unknown>)
      : undefined;
  if (trigger?.type !== "chained") return [];

  const steps = Array.isArray(r.steps)
    ? (r.steps as Array<Record<string, unknown>>)
    : [];
  const recipeDir = dirname(recipePath);
  const issues: LintIssue[] = [];

  // Mark the current recipe as visited before descending.
  const absPath = resolve(recipePath);
  visited.add(absPath);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    issues.push(...lintStep(step, i + 1, recipeDir, visited));
  }

  return issues;
}

/**
 * Check a single step (or recurse into its parallel: children).
 * `stepLabel` is the 1-based position string used in issue messages.
 */
function lintStep(
  step: Record<string, unknown>,
  stepLabel: number,
  recipeDir: string,
  visited: Set<string>,
): LintIssue[] {
  const issues: LintIssue[] = [];

  // Recurse into parallel: groups — each child is checked independently.
  if (Array.isArray(step.parallel)) {
    for (let j = 0; j < step.parallel.length; j++) {
      const child = step.parallel[j];
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      issues.push(
        ...lintStep(
          child as Record<string, unknown>,
          stepLabel,
          recipeDir,
          visited,
        ),
      );
    }
    return issues;
  }

  const ref =
    typeof step.chain === "string"
      ? step.chain
      : typeof step.recipe === "string"
        ? step.recipe
        : null;
  if (!ref) return issues;

  const field = typeof step.chain === "string" ? "chain" : "recipe";

  // Refs that look like file paths (extension or separator) → resolve relative to recipe dir.
  const looksLikePath =
    /\.ya?ml$/i.test(ref) ||
    ref.startsWith("./") ||
    ref.startsWith("../") ||
    /[\\/]/.test(ref);

  if (looksLikePath) {
    const resolved = /^\//.test(ref) ? ref : resolve(recipeDir, ref);
    const candidates = /\.ya?ml$/i.test(resolved)
      ? [resolved]
      : [`${resolved}.yaml`, `${resolved}.yml`, resolved];

    const childPath = candidates.find(existsSync) ?? null;
    if (!childPath) {
      issues.push({
        level: "error",
        message: `Step ${stepLabel}: '${field}: ${ref}' — file not found relative to recipe directory (${recipeDir})`,
      });
      return issues;
    }

    issues.push(...lintChildRecipe(childPath, field, ref, stepLabel, visited));
    return issues;
  }

  // Named ref (no extension, no separator) → check ~/.patchwork/recipes/.
  // Emit a warning rather than error: the recipe may be installed on the
  // deploy target but not the author's machine.
  if (existsSync(RECIPES_DIR)) {
    const found =
      findYamlRecipePath(RECIPES_DIR, ref) ??
      (existsSync(join(RECIPES_DIR, ref)) ? join(RECIPES_DIR, ref) : null);
    if (!found) {
      issues.push({
        level: "warning",
        message: `Step ${stepLabel}: '${field}: ${ref}' — recipe not found in ${RECIPES_DIR}`,
      });
    } else {
      issues.push(...lintChildRecipe(found, field, ref, stepLabel, visited));
    }
  }

  return issues;
}

/**
 * Read, parse, and validate a resolved child recipe path. Skips the file if
 * it has already been visited (cycle). Issues are prefixed with the parent
 * step context so the author knows where the problem originates.
 */
function lintChildRecipe(
  childPath: string,
  field: string,
  ref: string,
  stepNumber: number,
  visited: Set<string>,
): LintIssue[] {
  const absChild = resolve(childPath);
  if (visited.has(absChild)) return []; // cycle — already linted

  let childParsed: unknown;
  try {
    childParsed = parseYaml(readFileSync(childPath, "utf-8"));
  } catch (err) {
    return [
      {
        level: "error",
        message: `Step ${stepNumber}: '${field}: ${ref}' — could not read child recipe: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const childResult = validateRecipeDefinition(childParsed);
  const childChainIssues = lintChainRefs(childParsed, childPath, visited);

  return [
    ...childResult.issues.map((issue) => ({
      ...issue,
      message: `Step ${stepNumber}: '${field}: ${ref}' — child recipe invalid: ${issue.message}`,
    })),
    ...childChainIssues.map((issue) => ({
      ...issue,
      message: `Step ${stepNumber}: '${field}: ${ref}' — ${issue.message}`,
    })),
  ];
}

// patchwork recipe fmt
// ============================================================================

export interface FmtResult {
  formatted: string;
  changed: boolean;
}

/**
 * Format/normalize a recipe file.
 * - Normalizes YAML formatting
 * - Sorts keys in consistent order
 * - Validates and re-serializes
 */
export function runFmt(
  recipePath: string,
  options: { check?: boolean } = {},
): FmtResult {
  const content = readFileSync(recipePath, "utf-8");
  const { header: schemaHeader } = extractSchemaHeader(content);
  const recipe = normalizeRecipeForRuntime(
    parseYaml(content),
    console.warn,
  ) as YamlRecipe;

  // Normalize key order
  const normalized: Record<string, unknown> = {};
  const keyOrder = [
    "apiVersion",
    "version",
    "name",
    "description",
    "trigger",
    "context",
    "steps",
    "expect",
    "output",
    "on_error",
  ];

  for (const key of keyOrder) {
    if (key in recipe) {
      normalized[key] = recipe[key as keyof YamlRecipe];
    }
  }

  // Add any extra keys at the end
  for (const key of Object.keys(recipe)) {
    if (!keyOrder.includes(key)) {
      normalized[key] = recipe[key as keyof YamlRecipe];
    }
  }

  // Re-serialize with consistent formatting
  const formattedBody = stringifyYaml(normalized, {
    indent: 2,
    lineWidth: 100,
  });
  const formatted = schemaHeader
    ? `${schemaHeader}\n${formattedBody}`
    : formattedBody;

  const changed = formatted.trim() !== content.trim();

  if (!options.check) {
    writeFileSync(recipePath, formatted);
  }

  return { formatted, changed };
}

export interface FmtWatchOptions {
  recipePath: string;
  check?: boolean;
  onResult: (result: FmtResult) => void | Promise<void>;
  onError?: (err: Error) => void;
  debounceMs?: number;
  watchFactory?: WatchFactory;
}

/**
 * Watch a recipe file and re-run `runFmt` on every save (debounced).
 * Mirrors runPreflightWatch / runTestWatch — composes runWatch + runFmt.
 * Returns a stop function.
 */
export function runFmtWatch(options: FmtWatchOptions): () => void {
  const { recipePath, check, onResult, onError, debounceMs, watchFactory } =
    options;

  return runWatch({
    recipePath,
    onChange: async () => {
      const result = runFmt(recipePath, { check });
      await onResult(result);
    },
    ...(onError ? { onError } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(watchFactory ? { watchFactory } : {}),
  });
}

function extractSchemaHeader(content: string): { header?: string } {
  if (content.startsWith(`${RECIPE_SCHEMA_HEADER}\n`)) {
    return { header: RECIPE_SCHEMA_HEADER };
  }
  return {};
}

export interface RunRecipeOptions {
  dryRun?: boolean;
  step?: string;
  vars?: Record<string, string>;
  workdir?: string;
  deps?: Partial<RunnerDeps>;
}

export interface RunRecipeStepSelection {
  query: string;
  matchedBy: "id" | "into" | "tool";
  matchedValue: string;
}

export interface RunRecipeResult {
  recipe: YamlRecipe;
  recipePath: string;
  result: RunResult | import("../recipes/chainedRunner.js").ChainedRunResult;
  stepSelection?: RunRecipeStepSelection;
}

export interface RecipeExecutionSummary {
  ok: boolean;
  steps: number;
  outputs: string[];
  errorMessage?: string;
  failed?: number;
  skipped?: number;
}

export interface WatchedRecipeRunResult {
  lint: LintResult;
  run?: RunRecipeResult;
  summary?: RecipeExecutionSummary;
}

export async function runRecipe(
  recipeRef: string,
  options: RunRecipeOptions = {},
): Promise<RunRecipeResult> {
  const recipePath = resolveRecipePath(recipeRef);
  const recipe = loadYamlRecipe(recipePath);
  const triggerType = (
    recipe.trigger as unknown as Record<string, unknown> | undefined
  )?.type;

  if (options.step && triggerType === "chained") {
    throw new Error(
      `Single-step execution is not supported for chained recipes: ${recipe.name}`,
    );
  }

  const selection = options.step
    ? selectRecipeStep(recipe, options.step)
    : undefined;
  const recipeToRun: YamlRecipe = selection
    ? { ...recipe, steps: [selection.step] }
    : recipe;
  const runnerDeps: RunnerDeps = {
    ...options.deps,
    workdir: options.workdir ?? options.deps?.workdir ?? process.cwd(),
  };
  if (options.dryRun) {
    throw new Error("runRecipeDryPlan must be used for dry-run execution");
  }
  const result = await dispatchRecipe(
    recipeToRun,
    {
      ...runnerDeps,
      chainedDeps: buildChainedDeps(runnerDeps),
      chainedOptions: { sourcePath: recipePath },
    },
    options.vars ?? {},
  );

  return {
    recipe,
    recipePath,
    result,
    ...(selection
      ? {
          stepSelection: {
            query: selection.query,
            matchedBy: selection.matchedBy,
            matchedValue: selection.matchedValue,
          },
        }
      : {}),
  };
}

export function summarizeRecipeExecution(
  result: RunRecipeResult["result"],
): RecipeExecutionSummary {
  if ("stepsRun" in result) {
    return {
      ok: !result.errorMessage,
      steps: result.stepsRun,
      outputs: result.outputs,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  }

  return {
    ok: result.success,
    steps: result.summary.total,
    outputs: [],
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    failed: result.summary.failed,
    skipped: result.summary.skipped,
  };
}

/**
 * Normalize either a yamlRunner RunResult or a chainedRunner ChainedRunResult
 * into the RunStepResult[] shape expected by RecipeRunLog.appendDirect.
 * Returns undefined when the result has no step-level detail.
 */
export function extractRunLogStepResults(result: RunRecipeResult["result"]):
  | Array<{
      id: string;
      tool?: string;
      status: "ok" | "skipped" | "error";
      error?: string;
      durationMs: number;
    }>
  | undefined {
  if ("stepsRun" in result) {
    // yamlRunner: stepResults is already StepResult[]
    if (!Array.isArray(result.stepResults)) return undefined;
    return result.stepResults.map((s) => ({
      id: s.id,
      ...(s.tool ? { tool: s.tool } : {}),
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
      durationMs: s.durationMs,
    }));
  }

  // chainedRunner: stepResults is Map<string, ChainedStepRunResult>
  return [...result.stepResults.entries()].map(([id, s]) => ({
    id,
    status: s.skipped ? "skipped" : s.success ? "ok" : "error",
    durationMs: s.durationMs ?? 0,
    ...(s.error ? { error: s.error.message } : {}),
  }));
}

export function formatRunReport(
  result: RunRecipeResult["result"],
  recipeName: string,
): string {
  const lines: string[] = [];
  const hr = "─".repeat(48);

  if ("stepsRun" in result) {
    // Simple (non-chained) recipe — compact summary
    const ok = !result.errorMessage;
    lines.push(`${ok ? "✓" : "✗"} ${recipeName} — ${result.stepsRun} step(s)`);
    if (result.outputs.length > 0) {
      for (const o of result.outputs) lines.push(`  → ${o}`);
    }
    if (result.errorMessage) lines.push(`  Error: ${result.errorMessage}`);
    return lines.join("\n");
  }

  // Chained recipe — per-step table
  const { stepResults, summary } = result;
  const overallOk = result.success;
  lines.push(hr);
  lines.push(`Recipe: ${recipeName}`);
  lines.push(hr);

  for (const [id, step] of stepResults) {
    const icon = step.skipped ? "↷" : step.success ? "✓" : "✗";
    const dur = step.durationMs !== undefined ? ` (${step.durationMs}ms)` : "";
    const err = step.error ? `  → ${step.error.message}` : "";
    lines.push(`  ${icon} ${id}${dur}${err}`);
  }

  lines.push(hr);
  const parts = [`${summary.succeeded} ok`];
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  lines.push(`${overallOk ? "✓" : "✗"} ${parts.join(" · ")}`);
  return lines.join("\n");
}

export async function runWatchedRecipe(
  recipePath: string,
  options: Pick<RunRecipeOptions, "workdir" | "deps" | "vars"> = {},
): Promise<WatchedRecipeRunResult> {
  const lint = runLint(recipePath);
  if (!lint.valid) {
    return { lint };
  }

  const run = await runRecipe(recipePath, options);
  return {
    lint,
    run,
    summary: summarizeRecipeExecution(run.result),
  };
}

/**
 * Stable JSON schema version for machine-readable dry-run plans.
 * Bump on breaking shape changes; consumers (dashboard run timeline, external tools)
 * should gate on this field.
 */
export const DRY_RUN_PLAN_SCHEMA_VERSION = 1;

export interface RecipeDryRunPlanStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  /** Namespace derived from tool id (e.g. "gmail" from "gmail.fetch_unread"). */
  namespace?: string;
  into?: string;
  optional?: boolean;
  prompt?: string;
  params?: Record<string, unknown>;
  dependencies?: string[];
  condition?: string;
  /** Explicit risk on the step, or registry default when absent. */
  risk?: "low" | "medium" | "high";
  /** Registry metadata — true if the tool mutates external state. */
  isWrite?: boolean;
  /** Registry metadata — true if the tool calls an external SaaS connector. */
  isConnector?: boolean;
  /** True if the tool id is known to the registry (false → unresolved at plan time). */
  resolved?: boolean;
}

export interface RecipeDryRunPlan {
  /** Stable schema version for consumers. */
  schemaVersion: typeof DRY_RUN_PLAN_SCHEMA_VERSION;
  recipe: string;
  mode: "dry-run";
  triggerType: string;
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  stepSelection?: RunRecipeStepSelection;
  steps: RecipeDryRunPlanStep[];
  parallelGroups?: string[][];
  maxDepth?: number;
  /** Distinct connector namespaces referenced by the plan. */
  connectorNamespaces?: string[];
  /** True if any step is registry-tagged as a write/mutation. */
  hasWriteSteps?: boolean;
}

function enrichStepFromRegistry(
  step: RecipeDryRunPlanStep,
): RecipeDryRunPlanStep {
  if (step.type !== "tool" || !step.tool) {
    return step;
  }
  const namespace = step.tool.split(".")[0];
  const registered = getTool(step.tool);
  const enriched: RecipeDryRunPlanStep = { ...step };
  if (namespace) enriched.namespace = namespace;
  enriched.resolved = Boolean(registered);
  if (registered) {
    enriched.isWrite = registered.isWrite;
    enriched.isConnector = registered.isConnector === true;
    if (enriched.risk === undefined) {
      enriched.risk = registered.riskDefault;
    }
  }
  return enriched;
}

function summarizePlanSteps(
  steps: RecipeDryRunPlanStep[],
): Pick<RecipeDryRunPlan, "connectorNamespaces" | "hasWriteSteps"> {
  const connectors = new Set<string>();
  let hasWrite = false;
  for (const step of steps) {
    if (step.isConnector && step.namespace) connectors.add(step.namespace);
    if (step.isWrite) hasWrite = true;
  }
  return {
    connectorNamespaces: [...connectors].sort(),
    hasWriteSteps: hasWrite,
  };
}

export async function runRecipeDryPlan(
  recipeRef: string,
  options: RunRecipeOptions = {},
): Promise<RecipeDryRunPlan> {
  const recipePath = resolveRecipePath(recipeRef);
  const recipe = loadYamlRecipe(recipePath);
  const triggerType = (
    recipe.trigger as unknown as Record<string, unknown> | undefined
  )?.type;
  const selection = options.step
    ? selectRecipeStep(recipe, options.step)
    : undefined;
  const recipeToPlan: YamlRecipe = selection
    ? { ...recipe, steps: [selection.step] }
    : recipe;
  const generatedAt = new Date().toISOString();

  if (triggerType === "chained") {
    const { generateExecutionPlan } = await import(
      "../recipes/chainedRunner.js"
    );
    const plan = generateExecutionPlan(
      recipeToPlan as unknown as import("../recipes/chainedRunner.js").ChainedRecipe,
    );
    const steps: RecipeDryRunPlanStep[] = plan.steps.map((step) => {
      const base: RecipeDryRunPlanStep = { id: step.id, type: step.type };
      if (step.optional !== undefined) base.optional = step.optional;
      if (step.dependencies) base.dependencies = step.dependencies;
      if (step.condition !== undefined) base.condition = step.condition;
      if (step.risk !== undefined) base.risk = step.risk;
      const raw = step as unknown as { tool?: unknown; into?: unknown };
      if (typeof raw.tool === "string") base.tool = raw.tool;
      if (typeof raw.into === "string") base.into = raw.into;
      return enrichStepFromRegistry(base);
    });
    return {
      schemaVersion: DRY_RUN_PLAN_SCHEMA_VERSION,
      generatedAt,
      recipe: recipe.name,
      mode: "dry-run",
      triggerType,
      ...(selection ? { stepSelection: toStepSelection(selection) } : {}),
      steps,
      parallelGroups: plan.parallelGroups,
      maxDepth: plan.maxDepth,
      ...summarizePlanSteps(steps),
    };
  }

  const steps = buildSimpleRecipeDryRunSteps(
    recipeToPlan,
    options.vars ?? {},
  ).map(enrichStepFromRegistry);
  return {
    schemaVersion: DRY_RUN_PLAN_SCHEMA_VERSION,
    generatedAt,
    recipe: recipe.name,
    mode: "dry-run",
    triggerType: typeof triggerType === "string" ? triggerType : "manual",
    ...(selection ? { stepSelection: toStepSelection(selection) } : {}),
    steps,
    ...summarizePlanSteps(steps),
  };
}

// ============================================================================
// patchwork recipe preflight
// ============================================================================

export type PreflightIssueCode =
  | "unresolved-tool"
  | "unacknowledged-write"
  | "missing-fixture"
  | "lint-error"
  | "lint-warning"
  | "into-shadows-builtin"
  | "into-duplicate";

export interface PreflightIssue {
  level: "error" | "warning";
  code: PreflightIssueCode;
  message: string;
  stepId?: string;
  tool?: string;
  namespace?: string;
}

export interface PreflightResult {
  ok: boolean;
  recipe: string;
  issues: PreflightIssue[];
  plan: RecipeDryRunPlan;
}

export interface PreflightOptions extends RunRecipeOptions {
  /**
   * If true, steps tagged `isWrite: true` fail preflight unless the recipe opts in
   * via a matching `allowWrites` entry (tool id or namespace). Default: true.
   */
  requireWriteAck?: boolean;
  /**
   * Explicit allowlist of tool ids or namespaces the caller acknowledges as writes.
   * Example: `["slack.post_message", "github"]`.
   */
  allowWrites?: string[];
  /**
   * If true, missing fixture libraries for connector namespaces become errors.
   * Default: false — preflight is a policy check, not a mock-run.
   */
  requireFixtures?: boolean;
  /** Override fixtures dir (defaults to ~/.patchwork/fixtures). */
  fixturesDir?: string;
}

/**
 * Static policy check over a recipe: lint + dry-plan + unresolved/write/fixture checks.
 * No connector calls, no agent calls — safe to run in CI.
 */
export async function runPreflight(
  recipeRef: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const recipePath = resolveRecipePath(recipeRef);
  const issues: PreflightIssue[] = [];

  const lint = runLint(recipePath);
  for (const issue of lint.issues) {
    issues.push({
      level: issue.level,
      code: issue.level === "error" ? "lint-error" : "lint-warning",
      message: issue.message,
    });
  }

  const plan = await runRecipeDryPlan(recipeRef, options);

  const requireWriteAck = options.requireWriteAck ?? true;
  const allowlist = new Set(options.allowWrites ?? []);

  for (const step of plan.steps) {
    if (step.type === "tool" && step.tool && step.resolved === false) {
      issues.push({
        level: "error",
        code: "unresolved-tool",
        message: `Tool "${step.tool}" is not registered`,
        stepId: step.id,
        tool: step.tool,
        ...(step.namespace ? { namespace: step.namespace } : {}),
      });
    }

    if (
      requireWriteAck &&
      step.isWrite === true &&
      step.tool &&
      !allowlist.has(step.tool) &&
      !(step.namespace && allowlist.has(step.namespace))
    ) {
      issues.push({
        level: "error",
        code: "unacknowledged-write",
        message: `Step "${step.id}" performs a write via "${step.tool}" but is not acknowledged via allowWrites`,
        stepId: step.id,
        tool: step.tool,
        ...(step.namespace ? { namespace: step.namespace } : {}),
      });
    }
  }

  if (options.requireFixtures && plan.connectorNamespaces) {
    const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
    for (const ns of plan.connectorNamespaces) {
      const library = loadFixtureLibrary(join(fixturesDir, `${ns}.json`));
      if (!library) {
        issues.push({
          level: "error",
          code: "missing-fixture",
          message: `Missing fixture library for connector "${ns}" at ${fixturesDir}/${ns}.json`,
          namespace: ns,
        });
      }
    }
  }

  const ok = !issues.some((issue) => issue.level === "error");
  return { ok, recipe: plan.recipe, issues, plan };
}

export interface PreflightWatchOptions extends PreflightOptions {
  recipePath: string;
  onResult: (result: PreflightResult) => void | Promise<void>;
  onError?: (err: Error) => void;
  debounceMs?: number;
  watchFactory?: WatchFactory;
}

/**
 * Watch a recipe file and run preflight on every save (debounced). Composes
 * runWatch + runPreflight so editor integrations get live policy feedback
 * without spawning the CLI per keystroke.
 *
 * Returns a stop function. If a preflight is in-flight when a new save lands,
 * at most one rerun is queued (matches runWatch semantics).
 */
export function runPreflightWatch(options: PreflightWatchOptions): () => void {
  const {
    recipePath,
    onResult,
    onError,
    debounceMs,
    watchFactory,
    ...preflightOptions
  } = options;

  const watchOptions: WatchOptions = {
    recipePath,
    onChange: async () => {
      const result = await runPreflight(recipePath, preflightOptions);
      await onResult(result);
    },
    ...(onError ? { onError } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(watchFactory ? { watchFactory } : {}),
  };

  return runWatch(watchOptions);
}

function resolveRecipePath(recipeRef: string): string {
  const directPath = resolve(recipeRef);
  if (existsSync(directPath) && statSync(directPath).isFile()) {
    return directPath;
  }

  const bundledDir = fileURLToPath(
    new URL("../../templates/recipes", import.meta.url),
  );
  const normalizedRef = recipeRef.replace(/\.(yaml|yml|json)$/i, "");
  const candidates = [
    join(RECIPES_DIR, `${normalizedRef}.yaml`),
    join(RECIPES_DIR, `${normalizedRef}.yml`),
    join(RECIPES_DIR, `${normalizedRef}.json`),
    join(bundledDir, `${normalizedRef}.yaml`),
    join(bundledDir, `${normalizedRef}.yml`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `recipe "${basename(recipeRef)}" not found in ${RECIPES_DIR}`,
  );
}

function selectRecipeStep(
  recipe: YamlRecipe,
  query: string,
): RunRecipeStepSelection & { step: YamlStep } {
  const matches = recipe.steps
    .map((step) => {
      const match = matchRecipeStep(step, query);
      return match ? { ...match, query, step } : undefined;
    })
    .filter(
      (
        match,
      ): match is RunRecipeStepSelection & {
        step: YamlStep;
      } => Boolean(match),
    );

  if (matches.length === 0) {
    throw new Error(`Step "${query}" not found in recipe "${recipe.name}"`);
  }

  if (matches.length > 1) {
    const labels = matches
      .map((match) => `${match.matchedBy}:${match.matchedValue}`)
      .join(", ");
    throw new Error(
      `Step "${query}" is ambiguous in recipe "${recipe.name}": ${labels}`,
    );
  }

  const [match] = matches;
  if (!match) {
    throw new Error(`Step "${query}" not found in recipe "${recipe.name}"`);
  }

  return match;
}

function matchRecipeStep(
  step: YamlStep,
  query: string,
): Omit<RunRecipeStepSelection, "query"> | null {
  const id = typeof step.id === "string" ? step.id : undefined;
  if (id === query) {
    return { matchedBy: "id", matchedValue: id };
  }

  const into = getStepInto(step);
  if (into === query) {
    return { matchedBy: "into", matchedValue: into };
  }

  const tool = typeof step.tool === "string" ? step.tool : undefined;
  if (tool === query) {
    return { matchedBy: "tool", matchedValue: tool };
  }

  return null;
}

function getStepInto(step: YamlStep): string | undefined {
  if (typeof step.into === "string" && step.into) {
    return step.into;
  }

  if (
    step.agent &&
    typeof step.agent === "object" &&
    typeof step.agent.into === "string" &&
    step.agent.into
  ) {
    return step.agent.into;
  }

  return undefined;
}

function toStepSelection(
  selection: RunRecipeStepSelection,
): RunRecipeStepSelection {
  return {
    query: selection.query,
    matchedBy: selection.matchedBy,
    matchedValue: selection.matchedValue,
  };
}

function buildSimpleRecipeDryRunSteps(
  recipe: YamlRecipe,
  vars: Record<string, string>,
): RecipeDryRunPlan["steps"] {
  const now = new Date();
  const ctx: Record<string, string> = {
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 5),
    ...vars,
  };

  return recipe.steps.map((step, index) => {
    const id =
      (typeof step.id === "string" && step.id) ||
      getStepInto(step) ||
      step.tool ||
      `step_${index}`;

    if (step.agent) {
      const prompt = render(step.agent.prompt, ctx);
      const into = getStepInto(step);
      if (into) {
        ctx[into] = `[dry-run:${id}]`;
      }
      return {
        id,
        type: "agent" as const,
        into,
        optional: step.optional,
        prompt,
      };
    }

    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
      if (key === "tool" || key === "agent" || key === "into" || key === "id") {
        continue;
      }
      params[key] = typeof value === "string" ? render(value, ctx) : value;
    }

    const into = getStepInto(step);
    if (into) {
      ctx[into] = `[dry-run:${id}]`;
      if (step.tool) {
        seedToolOutputPreviewContext(step.tool, into, id, ctx);
      }
    }

    return {
      id,
      type: "tool" as const,
      tool: step.tool,
      into,
      optional: step.optional,
      params,
    };
  });
}

export interface RecipeTestResult {
  valid: boolean;
  issues: LintIssue[];
  warnings: number;
  errors: number;
  requiredFixtures: string[];
  missingFixtures: string[];
  stepsRun: number;
  outputs: string[];
  assertionFailures: import("../recipes/yamlRunner.js").AssertionFailure[];
}

export interface RecipeRecordResult {
  valid: boolean;
  issues: LintIssue[];
  warnings: number;
  errors: number;
  recordedFixtures: string[];
  stepsRun: number;
  outputs: string[];
}

export async function runRecord(
  recipePath: string,
  options: { fixturesDir?: string; deps?: Partial<RunnerDeps> } = {},
): Promise<RecipeRecordResult> {
  const lint = runLint(recipePath);
  const issues = [...lint.issues];
  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
  let recordedFixtures: string[] = [];
  let stepsRun = 0;
  let outputs: string[] = [];

  if (issues.every((issue) => issue.level !== "error")) {
    try {
      const recipe = loadYamlRecipe(recipePath);
      recordedFixtures = getRequiredFixtureNamespaces(
        recipe.steps as Array<Record<string, unknown>>,
      );
      const run = await runYamlRecipe(recipe, {
        ...options.deps,
        recordFixturesDir: fixturesDir,
      });
      stepsRun = run.stepsRun;
      outputs = run.outputs;

      if (run.errorMessage) {
        issues.push({
          level: "error",
          message: run.errorMessage,
        });
      }
    } catch (err) {
      issues.push({
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errors = issues.filter((issue) => issue.level === "error").length;
  const warnings = issues.filter((issue) => issue.level === "warning").length;

  return {
    valid: errors === 0,
    issues,
    warnings,
    errors,
    recordedFixtures,
    stepsRun,
    outputs,
  };
}

export async function runTest(
  recipePath: string,
  options: { fixturesDir?: string } = {},
): Promise<RecipeTestResult> {
  const lint = runLint(recipePath);
  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
  const issues = [...lint.issues];
  let requiredFixtures: string[] = [];
  let stepsRun = 0;
  let outputs: string[] = [];
  let assertionFailures: import("../recipes/yamlRunner.js").AssertionFailure[] =
    [];

  if (existsSync(recipePath)) {
    try {
      const recipe = parseYaml(readFileSync(recipePath, "utf-8")) as {
        steps?: Array<Record<string, unknown>>;
      };
      requiredFixtures = getRequiredFixtureNamespaces(recipe.steps ?? []);
    } catch {
      requiredFixtures = [];
    }
  }

  const missingFixtures = requiredFixtures.filter(
    (provider) => !existsSync(join(fixturesDir, `${provider}.json`)),
  );

  for (const provider of missingFixtures) {
    issues.push({
      level: "error",
      message: `Missing fixture library for connector '${provider}' at ${join(fixturesDir, `${provider}.json`)}`,
    });
  }

  if (issues.every((issue) => issue.level !== "error")) {
    try {
      const recipe = loadYamlRecipe(recipePath);
      const triggerType = (
        recipe.trigger as unknown as Record<string, unknown> | undefined
      )?.type;

      if (triggerType === "chained") {
        // Chained recipes: run through chainedRunner with mocked tool + agent executors
        const { runChainedRecipe } = await import(
          "../recipes/chainedRunner.js"
        );
        const { evaluateExpect } = await import("../recipes/yamlRunner.js");
        const chainedRecipe =
          recipe as unknown as import("../recipes/chainedRunner.js").ChainedRecipe;
        const recipeRecord = recipe as unknown as Record<string, unknown>;
        const run = await runChainedRecipe(
          chainedRecipe,
          {
            env: process.env as Record<string, string>,
            maxConcurrency: (recipeRecord.maxConcurrency as number) ?? 4,
            maxDepth: (recipeRecord.maxDepth as number) ?? 3,
            dryRun: false,
            sourcePath: recipePath,
          },
          {
            executeTool: async (tool) => `[mock:${tool}]`,
            executeAgent: async () => "[mock agent output]",
            loadNestedRecipe: async () => null,
          },
        );
        stepsRun = run.summary.total;
        if (run.errorMessage) {
          issues.push({ level: "error", message: run.errorMessage });
        }

        // Evaluate expect: block against chained run results
        const expectBlock = recipeRecord.expect as
          | import("../recipes/yamlRunner.js").YamlRecipeExpect
          | undefined;
        if (expectBlock) {
          const failures = evaluateExpect(
            {
              stepsRun: run.summary.total,
              outputs: [],
              context: run.context,
              errorMessage: run.errorMessage,
            },
            expectBlock,
          );
          assertionFailures = failures;
          for (const failure of failures) {
            issues.push({ level: "error", message: failure.message });
          }
        }
      } else {
        const mockConnectors = createMockToolConnectors(
          recipe.steps,
          fixturesDir,
        );
        const run = await runYamlRecipe(recipe, {
          testMode: true,
          mockConnectors,
          readFile: (filePath) => readFileSync(filePath, "utf-8"),
          writeFile: () => {},
          appendFile: () => {},
          mkdir: () => {},
          gitLogSince: () => "[mock git log]",
          gitStaleBranches: () => "[mock stale branches]",
          getDiagnostics: () => "[mock diagnostics]",
          claudeFn: async () => "[mock agent output]",
          claudeCodeFn: async () => "[mock agent output]",
          providerDriverFn: async () => "[mock agent output]",
        });
        stepsRun = run.stepsRun;
        outputs = run.outputs;

        if (run.assertionFailures && run.assertionFailures.length > 0) {
          assertionFailures = run.assertionFailures;
          for (const failure of run.assertionFailures) {
            issues.push({ level: "error", message: failure.message });
          }
        }

        if (run.errorMessage) {
          issues.push({ level: "error", message: run.errorMessage });
        }
      }
    } catch (err) {
      issues.push({
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errors = issues.filter((issue) => issue.level === "error").length;
  const warnings = issues.filter((issue) => issue.level === "warning").length;

  return {
    valid: errors === 0,
    issues,
    warnings,
    errors,
    requiredFixtures,
    missingFixtures,
    stepsRun,
    outputs,
    assertionFailures,
  };
}

export interface TestWatchOptions {
  recipePath: string;
  fixturesDir?: string;
  onResult: (result: RecipeTestResult) => void | Promise<void>;
  onError?: (err: Error) => void;
  debounceMs?: number;
  watchFactory?: WatchFactory;
}

/**
 * Watch a recipe file and re-run `patchwork recipe test` on every save (debounced).
 * Mirrors runPreflightWatch — composes runWatch + runTest.
 * Returns a stop function.
 */
export function runTestWatch(options: TestWatchOptions): () => void {
  const {
    recipePath,
    fixturesDir,
    onResult,
    onError,
    debounceMs,
    watchFactory,
  } = options;

  return runWatch({
    recipePath,
    onChange: async () => {
      const result = await runTest(recipePath, { fixturesDir });
      await onResult(result);
    },
    ...(onError ? { onError } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(watchFactory ? { watchFactory } : {}),
  });
}

function getRequiredFixtureNamespaces(
  steps: Array<Record<string, unknown>>,
): string[] {
  const namespaces = new Set<string>();
  for (const step of steps) {
    const tool = step.tool;
    if (typeof tool !== "string") {
      continue;
    }
    const namespace = tool.split(".")[0];
    if (namespace && isConnectorNamespace(namespace)) {
      namespaces.add(namespace);
    }
  }
  return [...namespaces].sort();
}

function createMockToolConnectors(
  steps: Array<Record<string, unknown>>,
  fixturesDir: string,
): Partial<Record<string, MockToolConnector>> {
  const providerConnectors = new Map<string, MockConnector>();
  const toolConnectors: Partial<Record<string, MockToolConnector>> = {};

  for (const step of steps) {
    const tool = step.tool;
    if (typeof tool !== "string") {
      continue;
    }
    const [namespace, operation] = tool.split(".");
    if (!namespace || !operation || !isConnectorNamespace(namespace)) {
      continue;
    }
    let connector = providerConnectors.get(namespace);
    if (!connector) {
      connector = new MockConnector(namespace, {
        fixturePath: join(fixturesDir, `${namespace}.json`),
      });
      providerConnectors.set(namespace, connector);
    }
    toolConnectors[tool] = {
      invoke: async <TOutput = unknown>(
        _unusedOperation: string,
        input?: unknown,
      ) => {
        const output = await connector.invoke(operation, input);
        return (
          typeof output === "string" ? output : JSON.stringify(output)
        ) as TOutput;
      },
    };
  }

  return toolConnectors;
}

// patchwork recipe watch
// ============================================================================

type WatchFactory = (
  path: string,
  options: { recursive: boolean },
  listener: (eventType: string, changedFile: string | Buffer | null) => void,
) => {
  close(): void;
};

export interface WatchOptions {
  recipePath: string;
  onChange: () => void | Promise<void>;
  onError?: (err: Error) => void;
  debounceMs?: number;
  watchFactory?: WatchFactory;
}

function normalizeChangedFile(
  changedFile: string | Buffer | null,
): string | null {
  if (typeof changedFile === "string") {
    return changedFile;
  }

  if (changedFile instanceof Buffer) {
    return changedFile.toString();
  }

  return null;
}

export function runWatch(options: WatchOptions): () => void {
  const dir = dirname(resolve(options.recipePath));
  const filename = basename(options.recipePath);
  const debounceMs = options.debounceMs ?? 300;
  const watchFactory: WatchFactory =
    options.watchFactory ??
    ((watchPath, watchOptions, listener) =>
      watch(watchPath, watchOptions, listener));
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunQueued = false;
  let stopped = false;

  const handleError = (err: unknown): void => {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  const finishChange = (): void => {
    running = false;
    if (stopped || !rerunQueued) {
      return;
    }
    rerunQueued = false;
    executeChange();
  };

  const executeChange = (): void => {
    if (stopped) {
      return;
    }

    if (running) {
      rerunQueued = true;
      return;
    }

    running = true;
    try {
      const changeResult = options.onChange();
      void Promise.resolve(changeResult)
        .catch(handleError)
        .finally(finishChange);
    } catch (err) {
      handleError(err);
      finishChange();
    }
  };

  const scheduleChange = (): void => {
    if (stopped) {
      return;
    }

    if (running) {
      rerunQueued = true;
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      executeChange();
    }, debounceMs);
  };

  const watcher = watchFactory(
    dir,
    { recursive: false },
    (_eventType, changedFile) => {
      const changedName = normalizeChangedFile(changedFile);
      if (changedName === filename) {
        scheduleChange();
      }
    },
  );

  // Return cleanup function
  return () => {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher.close();
  };
}
