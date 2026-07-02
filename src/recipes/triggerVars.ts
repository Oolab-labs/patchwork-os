import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Read a YAML recipe's `trigger.inputs[]` / `trigger.vars[]` declarations and
 * merge any declared defaults underneath caller-provided vars. Caller vars
 * always win. Tolerates missing files / malformed YAML / non-array inputs by
 * returning the original vars untouched.
 *
 * Leaf module (no recipe-runner deps) so BOTH the high-level orchestration
 * wiring (`recipeOrchestration.ts`) and the low-level `RecipeOrchestrator.fire`
 * chokepoint can apply defaults without a circular import. `RecipeOrchestrator.fire`
 * calls this so EVERY fire path (HTTP webhook, CLI, scheduler, automation hooks)
 * gets declared defaults merged — previously only the manual/HTTP path did, so an
 * `on_test_run`-triggered recipe fired with only the event placeholders and its
 * declared `repo` default was dropped (the filing then hard-errored on empty repo).
 */
export function applyTriggerInputDefaults(
  ymlPath: string,
  vars?: Record<string, string>,
): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(ymlPath, "utf-8"));
  } catch {
    return vars;
  }
  const trigger = (parsed as { trigger?: unknown } | null)?.trigger as
    | Record<string, unknown>
    | null
    | undefined;

  // Collect defaults from both trigger.inputs and trigger.vars (array forms).
  // trigger.vars holds recipe-declared defaults; trigger.inputs holds
  // user-overrideable parameters. Both use {name, default} entries.
  const defaults: Record<string, string> = {};
  for (const key of ["inputs", "vars"] as const) {
    const arr = trigger?.[key];
    if (arr !== undefined && !Array.isArray(arr) && typeof arr === "object") {
      // Map format (vars: {NAME: value}) is not supported — values silently
      // never reach the recipe context. Warn so authors catch the mistake early.
      console.warn(
        `[recipe] trigger.${key} must be an array of {name, default} objects, ` +
          `got a plain object in ${ymlPath}. Vars will not be substituted.`,
      );
    }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      const dflt = (item as { default?: unknown }).default;
      if (typeof name !== "string" || name.length === 0) continue;
      if (dflt === undefined || dflt === null) continue;
      if (!(name in defaults)) defaults[name] = String(dflt);
    }
  }

  if (Object.keys(defaults).length === 0) return vars;
  return { ...defaults, ...(vars ?? {}) };
}
