/**
 * Template Engine — safe template resolution for recipe step outputs.
 *
 * Replaces the deprecated `vm2` approach with a pure AST-based evaluator.
 * Supports: `{{steps.X.data}}`, `{{steps.X.data.field.subfield}}`, `{{env.Y}}`
 *
 * Security: No eval, no Function constructor, no VM. Just path walking.
 */

export interface TemplateContext {
  steps: Record<string, StepOutput>;
  env: Record<string, string | undefined>;
}

export interface StepOutput {
  status: "success" | "error" | "skipped";
  data: unknown;
  metadata?: {
    startedAt: Date;
    completedAt: Date;
    model?: string;
    tokenUsage?: number;
  };
}

export interface TemplateCompileError {
  type: "compile_error";
  template: string;
  message: string;
}

export interface TemplateEvalError {
  type: "eval_error";
  template: string;
  path: string;
  message: string;
}

export type TemplateError = TemplateCompileError | TemplateEvalError;

// Pre-compiled template for performance
export interface CompiledTemplate {
  readonly source: string;
  readonly hasTemplates: boolean;
  evaluate(
    context: TemplateContext,
  ): { value: string } | { error: TemplateError };
}

/**
 * Compile a template string into an executable form.
 * Parses `{{...}}` expressions once, not per-evaluation.
 */
export function compileTemplate(template: string): CompiledTemplate {
  const parts: (string | { path: string; type: "step" | "env" })[] = [];

  // Match {{expression}} — non-greedy, no nesting
  const regex = /\{\{([^{}]+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    // Add literal text before this match
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }

    const expression = match[1]?.trim();
    if (!expression) continue;
    const parsed = parseExpression(expression);

    if (!parsed) {
      return {
        source: template,
        hasTemplates: true,
        evaluate: () => ({
          error: {
            type: "compile_error",
            template,
            message: `Invalid expression: ${expression}`,
          },
        }),
      };
    }

    parts.push(parsed);
    lastIndex = regex.lastIndex;
  }

  // Add remaining literal text
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }

  return {
    source: template,
    hasTemplates: parts.some((p) => typeof p !== "string"),
    evaluate: (context) => evaluateCompiled(parts, context),
  };
}

/**
 * Parse an expression like "steps.X.data.field" or "env.HOME"
 * Returns null if invalid syntax.
 */
function parseExpression(
  expr: string,
): { path: string; type: "step" | "env" } | null {
  const parts = expr.split(".");
  if (parts.length < 2) return null;

  const root = parts[0];
  const rest = parts.slice(1);

  if (root === "steps" && rest.length >= 2) {
    // steps.X.data or steps.X.data.field
    return { path: expr, type: "step" };
  }

  if (root === "env" && rest.length === 1) {
    // env.HOME
    return { path: expr, type: "env" };
  }

  return null;
}

function evaluateCompiled(
  parts: (string | { path: string; type: "step" | "env" })[],
  context: TemplateContext,
): { value: string } | { error: TemplateError } {
  const values: string[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      values.push(part);
      continue;
    }

    const result = evaluateExpression(part, context);
    if ("error" in result) {
      return result;
    }
    values.push(result.value);
  }

  return { value: values.join("") };
}

function evaluateExpression(
  expr: { path: string; type: "step" | "env" },
  context: TemplateContext,
): { value: string } | { error: TemplateError } {
  const parts = expr.path.split(".");

  if (expr.type === "env") {
    const key = parts[1];
    if (!key) return { value: "" };
    const value = context.env[key];
    return {
      value: value ?? "",
    };
  }

  // steps.X.data.path...
  const stepId = parts[1];
  const dataKey = parts[2];
  const pathRest = parts.slice(3);
  if (!stepId || !dataKey) {
    return { value: "" };
  }
  const step = context.steps[stepId];

  if (!step) {
    return {
      error: {
        type: "eval_error",
        template: `{{${expr.path}}}`,
        path: expr.path,
        message: `Step '${stepId}' not found`,
      },
    };
  }

  if (dataKey !== "data" && dataKey !== "status" && dataKey !== "metadata") {
    return {
      error: {
        type: "eval_error",
        template: `{{${expr.path}}}`,
        path: expr.path,
        message: `Invalid step accessor '${dataKey}', expected 'data', 'status', or 'metadata'`,
      },
    };
  }

  let value: unknown = step[dataKey as keyof StepOutput];

  // Walk the rest of the path
  for (const key of pathRest) {
    if (value === null || value === undefined) {
      return { value: "" }; // Missing path resolves to empty string
    }
    if (Array.isArray(value)) {
      const index = parseInt(key, 10);
      if (Number.isNaN(index) || index < 0 || index >= value.length) {
        return { value: "" };
      }
      value = value[index];
    } else if (typeof value === "object") {
      value = (value as Record<string, unknown>)[key];
    } else {
      return { value: "" };
    }
  }

  // Serialize to string
  if (value === null || value === undefined) {
    return { value: "" };
  }
  if (typeof value === "string") {
    return { value };
  }
  return { value: JSON.stringify(value) };
}

/**
 * Convenience: compile and evaluate in one call.
 * Prefer pre-compilation for repeated evaluations.
 */
export function evaluateTemplate(
  template: string,
  context: TemplateContext,
): { value: string } | { error: TemplateError } {
  return compileTemplate(template).evaluate(context);
}

/**
 * Validate all templates in a recipe at load time.
 * Returns array of errors, empty if all valid.
 */
export function validateRecipeTemplates(templates: string[]): TemplateError[] {
  const errors: TemplateError[] = [];
  for (const template of templates) {
    const compiled = compileTemplate(template);
    if (!compiled.hasTemplates) continue; // literal — valid
    // Probe with empty context: compile_error surfaces regardless of runtime values
    const result = compiled.evaluate({ steps: {}, env: {} });
    if ("error" in result && result.error.type === "compile_error") {
      errors.push(result.error);
    }
  }
  return errors;
}
