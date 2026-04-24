function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRecipeForRuntime(recipe: unknown): unknown {
  if (!isRecord(recipe)) {
    return recipe;
  }

  const normalized: Record<string, unknown> = {
    ...recipe,
  };

  if (isRecord(normalized.trigger)) {
    normalized.trigger = normalizeLegacyTriggerForRuntime(normalized.trigger);
  }

  if (Array.isArray(normalized.steps)) {
    normalized.steps = normalized.steps.map((step) =>
      normalizeLegacyRuntimeStep(step),
    );
  }

  return normalized;
}

function normalizeLegacyTriggerForRuntime(
  trigger: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...trigger };

  if (
    normalized.type === "cron" &&
    typeof normalized.schedule === "string" &&
    typeof normalized.at !== "string"
  ) {
    normalized.at = normalized.schedule;
  }

  delete normalized.schedule;

  return normalized;
}

function normalizeLegacyRuntimeStep(step: unknown): unknown {
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
        normalizeLegacyRuntimeStep(entry),
      );
      continue;
    }
    if (key === "branch" && Array.isArray(value)) {
      normalized.branch = value.map((entry) =>
        normalizeLegacyBranchEntry(entry),
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
      agentConfig.prompt = step.prompt;
    }

    if (
      typeof step.output === "string" &&
      typeof agentConfig.into !== "string"
    ) {
      agentConfig.into = step.output;
    }

    normalized.agent = agentConfig;
    return normalized;
  }

  if (isRecord(step.params)) {
    Object.assign(normalized, step.params);
  }

  if (
    typeof normalized.recipe !== "string" &&
    typeof normalized.chain === "string"
  ) {
    normalized.recipe = normalized.chain;
  }
  delete normalized.chain;

  if (typeof normalized.into !== "string" && typeof step.output === "string") {
    normalized.into = step.output;
  }

  if (
    normalized.tool === "file.append" &&
    typeof normalized.content !== "string" &&
    typeof normalized.line === "string"
  ) {
    normalized.content = normalized.line;
    delete normalized.line;
  }

  return normalized;
}

function normalizeLegacyBranchEntry(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "otherwise" && isRecord(value)) {
      normalized.otherwise = normalizeLegacyRuntimeStep(value);
      continue;
    }
    normalized[key] = value;
  }

  if (Object.hasOwn(normalized, "otherwise")) {
    return normalized;
  }

  return normalizeLegacyRuntimeStep(entry);
}
