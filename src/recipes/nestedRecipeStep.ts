/**
 * NestedRecipeStep — handler for calling recipes from within recipes.
 *
 * Supports:
 *   - Variable passing via template resolution
 *   - Isolated OutputRegistry for child
 *   - Risk escalation (child risk > parent risk uses child's)
 *   - Depth limiting (prevent infinite recursion)
 */

import type { OutputRegistry } from "./outputRegistry.js";
import type { TemplateContext, TemplateError } from "./templateEngine.js";
import { compileTemplate } from "./templateEngine.js";

export interface NestedRecipeConfig {
  recipe: string; // recipe name or path
  vars: Record<string, string>; // template strings
  output?: string; // key to store result in parent registry
  risk?: "low" | "medium" | "high";
  id: string; // step id
}

export interface NestedRecipeContext {
  parentRegistry: OutputRegistry;
  parentEnv: Record<string, string | undefined>;
  recipeMaxDepth: number;
  currentDepth: number;
  dryRun: boolean;
}

export interface NestedRecipeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  childOutputs?: Record<string, unknown>;
}

export interface RecipeLoader {
  loadRecipe(name: string): Promise<{ steps: unknown[] } | null>;
}

/** Resolve template variables against parent context */
export function resolveNestedVars(
  vars: Record<string, string>,
  context: TemplateContext,
): { resolved: Record<string, string>; errors: TemplateError[] } {
  const resolved: Record<string, string> = {};
  const errors: TemplateError[] = [];

  for (const [key, templateStr] of Object.entries(vars)) {
    const compiled = compileTemplate(templateStr);
    const result = compiled.evaluate(context);

    if ("error" in result) {
      errors.push(result.error);
      resolved[key] = "";
    } else {
      resolved[key] = result.value;
    }
  }

  return { resolved, errors };
}

/** Validate nested recipe call before execution */
export function validateNestedRecipe(
  config: NestedRecipeConfig,
  context: NestedRecipeContext,
): { valid: boolean; error?: string } {
  if (context.currentDepth > context.recipeMaxDepth) {
    return {
      valid: false,
      error:
        `Recipe nesting depth limit (${context.recipeMaxDepth}) exceeded. ` +
        `Step "${config.id}" attempted to call "${config.recipe}" at depth ${context.currentDepth + 1}.`,
    };
  }

  if (!config.recipe || typeof config.recipe !== "string") {
    return {
      valid: false,
      error: `Invalid recipe reference in step "${config.id}": recipe name is required`,
    };
  }

  return { valid: true };
}

/** Calculate effective risk tier */
export function calculateNestedRisk(
  parentRisk: "low" | "medium" | "high" | undefined,
  childRisk: "low" | "medium" | "high" | undefined,
): "low" | "medium" | "high" {
  const tiers = { low: 1, medium: 2, high: 3 };
  const parentTier = tiers[parentRisk ?? "low"];
  const childTier = tiers[childRisk ?? "low"];
  const effective = Math.max(parentTier, childTier);
  return effective === 1 ? "low" : effective === 2 ? "medium" : "high";
}

/** Format nested recipe result for parent registry */
export function formatNestedOutput(
  result: NestedRecipeResult,
  config: NestedRecipeConfig,
): {
  stepId: string;
  output: {
    status: "success" | "error" | "skipped";
    data: unknown;
  };
} {
  return {
    stepId: config.output ?? config.id,
    output: {
      status: result.success ? "success" : "error",
      data: result.success
        ? {
            recipe: config.recipe,
            result: result.data,
            childOutputs: result.childOutputs,
          }
        : { error: result.error },
    },
  };
}

/** Mock nested recipe execution for dry-run mode */
export async function mockNestedRecipe(
  config: NestedRecipeConfig,
  context: NestedRecipeContext,
): Promise<NestedRecipeResult> {
  const validation = validateNestedRecipe(config, context);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Resolve templates to show what would be passed
  const parentContext = context.parentRegistry.toTemplateContext(
    context.parentEnv,
  );
  const { resolved, errors } = resolveNestedVars(config.vars, parentContext);

  if (errors.length > 0) {
    return {
      success: false,
      error: `Template errors: ${errors.map((e) => e.message).join(", ")}`,
    };
  }

  return {
    success: true,
    data: {
      dryRun: true,
      recipe: config.recipe,
      resolvedVars: resolved,
      effectiveRisk: calculateNestedRisk(undefined, config.risk),
      wouldExecuteAtDepth: context.currentDepth + 1,
    },
  };
}
