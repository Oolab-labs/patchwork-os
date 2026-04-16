import type {
  AutomationProgram,
  HookNode,
  HookType,
} from "../fp/automationProgram.js";
import {
  hook,
  withCooldown,
  withRateLimit,
  withRetry,
} from "../fp/automationProgram.js";
import type { Recipe, Trigger } from "./schema.js";

/**
 * Compile a Recipe into an AutomationProgram that the existing interpreter
 * can run. One Recipe produces one HookNode whose prompt is the rendered
 * multi-step workflow; wrappers add retry, cooldown, and rate-limit.
 *
 * Webhook, cron, and manual triggers have no native hook — they need wiring
 * in a later PR (HTTP endpoint, node-cron, CLI command). For now the compiler
 * rejects them with a clear message.
 */

export class RecipeCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeCompileError";
  }
}

const DEFAULT_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_PER_HOUR = 30;
const DEFAULT_RETRY_DELAY_MS = 10_000;

export function compileRecipe(recipe: Recipe): AutomationProgram {
  const { hookType, patterns } = mapTrigger(recipe.trigger, recipe.name);
  const prompt = buildPrompt(recipe);

  let program: AutomationProgram = hook({
    hookType,
    enabled: true,
    patterns,
    promptSource: { kind: "inline", prompt },
    extras: { kind: "none" },
  } satisfies Omit<HookNode, "_tag">);

  // retry wrapper
  const retryCount = recipe.on_error?.retry;
  if (retryCount && retryCount > 0) {
    program = withRetry(
      `recipe:${recipe.name}:retry`,
      retryCount,
      DEFAULT_RETRY_DELAY_MS,
      program,
    );
  }

  // cooldown wrapper
  program = withCooldown(
    `recipe:${recipe.name}:cooldown`,
    DEFAULT_COOLDOWN_MS,
    program,
  );

  // rate limit wrapper
  program = withRateLimit(DEFAULT_MAX_PER_HOUR, program);

  return program;
}

function mapTrigger(
  trigger: Trigger,
  recipeName: string,
): { hookType: HookType; patterns?: string[] } {
  switch (trigger.type) {
    case "file_watch":
      return { hookType: "onFileSave", patterns: trigger.patterns };
    case "git_hook":
      switch (trigger.event) {
        case "post-commit":
          return { hookType: "onGitCommit" };
        case "pre-push":
          return { hookType: "onGitPush" };
        case "post-merge":
          return { hookType: "onGitPull" };
      }
      break;
    case "webhook":
      throw new RecipeCompileError(
        `recipe '${recipeName}': webhook trigger requires the /hooks/* HTTP endpoint, not yet wired. Skip until Phase-2 HTTP patch.`,
      );
    case "cron":
      throw new RecipeCompileError(
        `recipe '${recipeName}': cron trigger requires the scheduler wiring, not yet landed. Use ~/.claude/scheduled-tasks/ templates as a workaround.`,
      );
    case "manual":
      throw new RecipeCompileError(
        `recipe '${recipeName}': manual trigger runs via the 'patchwork run <name>' CLI subcommand, not the automation interpreter.`,
      );
  }
  throw new RecipeCompileError(`recipe '${recipeName}': unknown trigger type`);
}

function buildPrompt(recipe: Recipe): string {
  const header =
    `# Recipe: ${recipe.name} (v${recipe.version})\n${recipe.description ?? ""}`.trim();
  const stepBlocks = recipe.steps.map((s, i) => {
    const idx = `Step ${i + 1}/${recipe.steps.length} — ${s.id}`;
    if (s.agent === true) {
      const tools = s.tools?.length
        ? `\nAllowed tools: ${s.tools.join(", ")}`
        : "";
      const risk = s.risk ? `\nRisk: ${s.risk}` : "";
      return `## ${idx} (agent)${tools}${risk}\n${s.prompt}`;
    }
    const paramsJson = JSON.stringify(s.params, null, 2);
    const risk = s.risk ? `\nRisk: ${s.risk}` : "";
    return `## ${idx} (tool: ${s.tool})${risk}\nInvoke the tool with:\n\`\`\`json\n${paramsJson}\n\`\`\``;
  });

  const footer = recipe.on_error
    ? `\n\n---\nOn error: ${JSON.stringify(recipe.on_error)}`
    : "";

  return `${header}\n\n${stepBlocks.join("\n\n")}${footer}`;
}
