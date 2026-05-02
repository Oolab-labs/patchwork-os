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

/**
 * Compile result containing both the AutomationProgram and a suggested
 * settings.json permissions snippet derived from the recipe's declared tools.
 * Users can merge `suggestedPermissions` into ~/.claude/settings.json's
 * `permissions.allow` array to pre-approve recipe steps and avoid per-run
 * dashboard prompts.
 */
export interface CompiledRecipe {
  program: AutomationProgram;
  suggestedPermissions: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
}

/**
 * Full compile — returns program + suggested CC permission snippet.
 *
 * Tool strings in recipe steps are interpreted using CC rule conventions:
 *   - Already-formatted like `Bash(npm run *)` or `Read(./.env)` pass through
 *   - Bare MCP tool names (e.g. `read_file`) get wrapped as-is
 *
 * Risk tier influences the destination bucket:
 *   - step.risk === "low"     → allow
 *   - step.risk === "medium"  → ask
 *   - step.risk === "high"    → ask (never auto-allow high-risk without user opt-in)
 *   - no risk declared        → allow (assume the recipe author trusts it)
 */
export function compileRecipeFull(recipe: Recipe): CompiledRecipe {
  return {
    program: compileRecipe(recipe),
    suggestedPermissions: derivePermissions(recipe),
  };
}

function derivePermissions(
  recipe: Recipe,
): CompiledRecipe["suggestedPermissions"] {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  for (const step of recipe.steps) {
    const rules = toolStringsForStep(step);
    const bucket = bucketForRisk(step.risk);
    const target = bucket === "allow" ? allow : bucket === "ask" ? ask : deny;
    for (const r of rules) target.add(r);
  }

  return {
    allow: [...allow].sort(),
    ask: [...ask].sort(),
    deny: [...deny].sort(),
  };
}

function toolStringsForStep(step: Recipe["steps"][number]): string[] {
  if (step.agent === true) {
    return (step.tools ?? []).map(normalizeToolString);
  }
  return [normalizeToolString(step.tool)];
}

function normalizeToolString(raw: string): string {
  // Already CC rule syntax — pass through.
  if (raw.includes("(") && raw.endsWith(")")) return raw;
  // Bare name — leave as plain tool rule (matches all uses).
  return raw;
}

function bucketForRisk(
  risk: Recipe["steps"][number]["risk"],
): "allow" | "ask" | "deny" {
  if (risk === "high") return "ask";
  if (risk === "medium") return "ask";
  return "allow";
}

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
        `recipe '${recipeName}': webhook triggers fire via POST /hooks/* (server.webhookFn) and bypass the automation interpreter — installer.ts skips compileRecipeFull for them. Reaching this branch means a non-bypass caller invoked compileTrigger directly; check the call site.`,
      );
    case "cron":
      throw new RecipeCompileError(
        `recipe '${recipeName}': cron triggers fire via RecipeScheduler and bypass the automation interpreter — installer.ts skips compileRecipeFull for them. Reaching this branch means a non-bypass caller invoked compileTrigger directly; check the call site.`,
      );
    case "manual":
      throw new RecipeCompileError(
        `recipe '${recipeName}': manual triggers run via 'patchwork run <name>' and bypass the automation interpreter — installer.ts skips compileRecipeFull for them. Reaching this branch means a non-bypass caller invoked compileTrigger directly; check the call site.`,
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
