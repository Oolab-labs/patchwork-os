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
  }

  const defaults: Record<string, string> = {};
  for (const input of declaredTriggerInputs(parsed)) {
    if (input.default !== undefined) defaults[input.name] = input.default;
  }

  if (Object.keys(defaults).length === 0) return vars;
  return { ...defaults, ...(vars ?? {}) };
}

export interface DeclaredTriggerInput {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

/**
 * The inputs a recipe declares, as the runtime reads them: `trigger.inputs[]`
 * then `trigger.vars[]` (array form only). A root-level `vars:` key is NOT
 * read — the runner ignores it, so reporting it would advertise inputs that
 * never reach the recipe.
 *
 * Shared by `applyTriggerInputDefaults` (default merging) and the recipe
 * listing (`GET /recipes`), so what the listing offers and what a run
 * receives cannot drift. Precedence matches the runtime exactly: the first
 * entry with a given name wins (inputs before vars), except that `default`
 * comes from the first entry with that name that HAS one — an `inputs` entry
 * with no default does not hide a `vars` default the runtime would apply.
 * Entries without a non-empty string `name` are skipped; a non-null `default`
 * is normalised with `String()`, as the runtime does.
 */
export function declaredTriggerInputs(parsed: unknown): DeclaredTriggerInput[] {
  const trigger = (parsed as { trigger?: unknown } | null | undefined)
    ?.trigger as Record<string, unknown> | null | undefined;
  if (!trigger || typeof trigger !== "object") return [];

  const byName = new Map<string, DeclaredTriggerInput>();
  for (const key of ["inputs", "vars"] as const) {
    const arr = trigger[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const name = rec.name;
      if (typeof name !== "string" || name.length === 0) continue;
      const dflt =
        rec.default === undefined || rec.default === null
          ? undefined
          : String(rec.default);
      const existing = byName.get(name);
      if (existing) {
        if (existing.default === undefined && dflt !== undefined) {
          existing.default = dflt;
        }
        continue;
      }
      const entry: DeclaredTriggerInput = { name };
      if (typeof rec.description === "string") {
        entry.description = rec.description;
      }
      if (typeof rec.required === "boolean") entry.required = rec.required;
      if (dflt !== undefined) entry.default = dflt;
      byName.set(name, entry);
    }
  }
  return [...byName.values()];
}
