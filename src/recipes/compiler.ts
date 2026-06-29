import type {
  AutomationProgram,
  HookExtras,
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
  // Fail CLOSED: only an explicit `low` (or no risk declared, i.e. the
  // author trusts it) auto-allows. EVERY other value — `medium`, `high`,
  // and any typo like `hgh` — routes to `ask`. The previous fall-through
  // to `allow` defeated the documented "never auto-allow high-risk"
  // guarantee for unrecognised values. `validateRecipeDefinition` flags
  // out-of-enum risk values so authors see the typo at lint time.
  if (risk === undefined || risk === "low") return "allow";
  return "ask";
}

export function compileRecipe(recipe: Recipe): AutomationProgram {
  const { hookType, patterns, extras } = mapTrigger(
    recipe.trigger,
    recipe.name,
  );

  let program: AutomationProgram = hook({
    hookType,
    enabled: true,
    patterns,
    // Use the recipe invocation path so the automation interpreter runs the
    // recipe through the recipe runner (with the worker gate) rather than
    // spawning a raw claude -p subprocess. This is what makes explicit recipe
    // tool steps (e.g. github.create_issue) observable and gateable by the
    // worker trust ramp.
    promptSource: { kind: "recipe", recipeName: recipe.name },
    extras: extras ?? { kind: "none" },
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
): { hookType: HookType; patterns?: string[]; extras?: HookExtras } {
  switch (trigger.type) {
    case "file_watch":
      return { hookType: "onFileSave", patterns: trigger.patterns };
    case "on_file_save":
      // Runtime-facing alias of file_watch. `glob` is optional — when absent
      // the interpreter's patterns check is skipped, so the hook fires on every
      // save (parity with how the bridge dispatches onFileSave from IDE events).
      return {
        hookType: "onFileSave",
        patterns: trigger.glob ? [trigger.glob] : undefined,
      };
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
    case "on_test_run":
      // Mirror loadPolicy's onTestRun.filter normalization so a recipe trigger
      // fires the SAME hook a policy-file entry would:
      //   - "failure"         → onTestRun gated on a non-zero failure count
      //   - "pass-after-fail" → the dedicated fail→pass transition hook
      //   - "any" / absent    → onTestRun on every run
      switch (trigger.filter) {
        case "failure":
          return {
            hookType: "onTestRun",
            extras: { kind: "testRun", onFailureOnly: true },
          };
        case "pass-after-fail":
          return { hookType: "onTestPassAfterFailure" };
        default:
          return { hookType: "onTestRun" };
      }
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
