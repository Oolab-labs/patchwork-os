/**
 * ChainedRecipeRunner — executes recipes with:
 *   - Parallel step execution (respecting dependencies)
 *   - Template-based variable resolution
 *   - Nested recipe calls
 *   - Conditional step execution (when)
 *   - Dry-run mode
 */

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
import type { TemplateContext, TemplateError } from "./templateEngine.js";
import { compileTemplate } from "./templateEngine.js";

export interface ChainedStep {
  id: string;
  tool?: string;
  agent?: { prompt: string; model?: string; driver?: string };
  recipe?: NestedRecipeConfig["recipe"];
  vars?: Record<string, string>;
  awaits?: string[];
  when?: string; // template condition
  output?: string; // alias for into
  risk?: "low" | "medium" | "high";
  optional?: boolean;
  [key: string]: unknown;
}

export interface ChainedRecipe {
  name: string;
  description?: string;
  steps: ChainedStep[];
  maxConcurrency?: number;
  maxDepth?: number;
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  maxConcurrency: number;
  maxDepth: number;
  dryRun: boolean;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, error?: Error) => void;
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
  loadNestedRecipe: (name: string) => Promise<ChainedRecipe | null>;
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
    "awaits",
    "when",
    "output",
    "risk",
    "optional",
    "vars",
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
    return {
      success: true,
      data: {
        dryRun: true,
        stepType: step.recipe ? "recipe" : step.agent ? "agent" : "tool",
        wouldExecute: (step.tool ?? step.agent) ? "prompt" : step.recipe,
        resolvedParams: Object.keys(resolved).length > 0 ? resolved : undefined,
      },
    };
  }

  // Execute based on step type
  try {
    if (step.recipe) {
      // Nested recipe call
      const nestedConfig: NestedRecipeConfig = {
        recipe: step.recipe,
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
      const nestedRecipe = await deps.loadNestedRecipe(step.recipe);
      if (!nestedRecipe) {
        return {
          success: false,
          error: `Nested recipe "${step.recipe}" not found`,
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
        env: { ...options.env, ...resolvedVars }, // Merge resolved vars into env
      };

      const childResult = await runChainedRecipe(
        nestedRecipe,
        childOptions,
        deps,
        childRegistry,
        depth + 1,
      );

      return {
        success: !childResult.errorMessage,
        data: {
          recipe: step.recipe,
          childSummary: childRegistry.summary(),
          childOutputs: Object.fromEntries(
            childRegistry.keys().map((k) => [k, childRegistry.get(k)?.data]),
          ),
        },
      };
    } else if (step.agent) {
      // Agent step
      const prompt = (resolved.agentPrompt as string) ?? step.agent.prompt;
      const result = await deps.executeAgent(
        prompt,
        step.agent.model,
        step.agent.driver,
      );
      return { success: true, data: result };
    } else if (step.tool) {
      // Tool step
      const result = await deps.executeTool(step.tool, resolved);
      return { success: true, data: result };
    } else {
      return { success: false, error: "Step has no tool, agent, or recipe" };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

export interface ChainedRunResult {
  success: boolean;
  stepResults: Map<string, { success: boolean; error?: Error }>;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  errorMessage?: string;
}

/** Main entry point: run a chained recipe */
export async function runChainedRecipe(
  recipe: ChainedRecipe,
  options: RunOptions,
  deps: ExecutionDeps,
  existingRegistry?: OutputRegistry,
  depth = 0,
): Promise<ChainedRunResult> {
  const registry = existingRegistry ?? createOutputRegistry();

  // Build dependency graph
  const depGraph = buildDependencyGraph(
    recipe.steps.map((s, i) => ({ id: s.id ?? `step_${i}`, awaits: s.awaits })),
  );

  if (depGraph.hasCycles) {
    return {
      success: false,
      stepResults: new Map(),
      summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      errorMessage: "Recipe has circular dependencies",
    };
  }

  // Create step lookup
  const stepMap = new Map<string, ChainedStep>();
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    if (!step) continue;
    const stepId = step.id ?? `step_${i}`;
    stepMap.set(stepId, { ...step, id: stepId });
  }

  // Execute with dependency tracking
  const execOptions: ExecutionOptions = {
    maxConcurrency: options.maxConcurrency,
    onStepStart: options.onStepStart,
    onStepComplete: options.onStepComplete,
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

    const result = await executeChainedStep(ctx, deps);

    const isOptional = step.optional === true;
    const effectiveSuccess = result.success || isOptional;

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

  // Calculate overall success
  let failed = 0;
  for (const [_, result] of stepResults) {
    if (!result.success) failed++;
  }

  return {
    success: failed === 0,
    stepResults,
    summary: registry.summary(),
    errorMessage: failed > 0 ? `${failed} step(s) failed` : undefined,
  };
}

/** Generate execution plan for dry-run mode */
export function generateExecutionPlan(recipe: ChainedRecipe): {
  steps: Array<{
    id: string;
    type: "tool" | "agent" | "recipe";
    dependencies: string[];
    condition?: string;
    risk: "low" | "medium" | "high";
  }>;
  parallelGroups: string[][];
  maxDepth: number;
} {
  const depGraph = buildDependencyGraph(
    recipe.steps.map((s, i) => ({ id: s.id ?? `step_${i}`, awaits: s.awaits })),
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
    steps: recipe.steps.map((s) => ({
      id: s.id!,
      type: s.recipe ? "recipe" : s.agent ? "agent" : "tool",
      dependencies: s.awaits ?? [],
      condition: s.when,
      risk: s.risk ?? "low",
    })),
    parallelGroups: levels,
    maxDepth: recipe.maxDepth ?? 3,
  };
}
