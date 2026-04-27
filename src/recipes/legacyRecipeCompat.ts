function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type WarnFn = (msg: string) => void;

/**
 * Default deprecation-warning sink for the runtime/validation/fmt callers.
 * Forwards to `console.warn` outside of tests so users see migration
 * prompts in CLI output, but stays silent under vitest so the dozens of
 * intentional legacy-shape regression fixtures don't flood stderr. Tests
 * that need to assert warnings still pass their own `vi.fn()` directly.
 */
export const defaultDeprecationWarn: WarnFn = (msg) => {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  console.warn(msg);
};

export function normalizeRecipeForRuntime(
  recipe: unknown,
  warn?: WarnFn,
): unknown {
  if (!isRecord(recipe)) {
    return recipe;
  }

  const normalized: Record<string, unknown> = {
    ...recipe,
  };

  if (isRecord(normalized.trigger)) {
    normalized.trigger = normalizeLegacyTriggerForRuntime(
      normalized.trigger,
      warn,
    );
  }

  if (Array.isArray(normalized.steps)) {
    normalized.steps = normalized.steps.map((step) =>
      normalizeLegacyRuntimeStep(step, warn),
    );
  }

  return normalized;
}

function normalizeLegacyTriggerForRuntime(
  trigger: Record<string, unknown>,
  warn?: WarnFn,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...trigger };

  if (
    normalized.type === "cron" &&
    typeof normalized.schedule === "string" &&
    typeof normalized.at !== "string"
  ) {
    warn?.(
      "Deprecated recipe field: trigger.schedule — rename to trigger.at (will be removed in a future major version)",
    );
    normalized.at = normalized.schedule;
  }

  delete normalized.schedule;

  return normalized;
}

function normalizeLegacyRuntimeStep(step: unknown, warn?: WarnFn): unknown {
  if (!isRecord(step)) {
    return step;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(step)) {
    if (key === "params" || key === "output" || key === "prompt") {
      continue;
    }
    if (key === "agent" && typeof value === "boolean") {
      continue;
    }
    if (key === "parallel" && Array.isArray(value)) {
      normalized.parallel = value.map((entry) =>
        normalizeLegacyRuntimeStep(entry, warn),
      );
      continue;
    }
    if (key === "branch" && Array.isArray(value)) {
      normalized.branch = value.map((entry) =>
        normalizeLegacyBranchEntry(entry, warn),
      );
      continue;
    }
    normalized[key] = value;
  }

  if (step.agent === true || isRecord(step.agent)) {
    const agentConfig: Record<string, unknown> = isRecord(step.agent)
      ? { ...step.agent }
      : {};

    if (
      typeof step.prompt === "string" &&
      typeof agentConfig.prompt !== "string"
    ) {
      warn?.(
        "Deprecated recipe step field: prompt at step level — move to step.agent.prompt (will be removed in a future major version)",
      );
      agentConfig.prompt = step.prompt;
    }

    if (
      typeof step.output === "string" &&
      typeof agentConfig.into !== "string"
    ) {
      warn?.(
        "Deprecated recipe step field: output — use step.agent.into instead (will be removed in a future major version)",
      );
      agentConfig.into = step.output;
    }

    if (step.agent === true) {
      warn?.(
        "Deprecated recipe step field: agent: true — use agent: { prompt, into } object instead (will be removed in a future major version)",
      );
    }

    normalized.agent = agentConfig;
    return normalized;
  }

  if (isRecord(step.params)) {
    warn?.(
      "Deprecated recipe step field: params — inline fields directly on the step (will be removed in a future major version)",
    );
    Object.assign(normalized, step.params);
  }

  if (
    typeof normalized.recipe !== "string" &&
    typeof normalized.chain === "string"
  ) {
    warn?.(
      "Deprecated recipe step field: chain — rename to recipe (will be removed in a future major version)",
    );
    normalized.recipe = normalized.chain;
  }
  delete normalized.chain;

  if (typeof normalized.into !== "string" && typeof step.output === "string") {
    warn?.(
      "Deprecated recipe step field: output — rename to into (will be removed in a future major version)",
    );
    normalized.into = step.output;
  }

  if (
    normalized.tool === "file.append" &&
    typeof normalized.content !== "string" &&
    typeof normalized.line === "string"
  ) {
    warn?.(
      "Deprecated recipe step field: line (file.append) — rename to content (will be removed in a future major version)",
    );
    normalized.content = normalized.line;
    delete normalized.line;
  }

  return normalized;
}

function normalizeLegacyBranchEntry(entry: unknown, warn?: WarnFn): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "otherwise" && isRecord(value)) {
      normalized.otherwise = normalizeLegacyRuntimeStep(value, warn);
      continue;
    }
    normalized[key] = value;
  }

  if (Object.hasOwn(normalized, "otherwise")) {
    return normalized;
  }

  return normalizeLegacyRuntimeStep(entry, warn);
}
