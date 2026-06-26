import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AutomationProgram } from "../fp/automationProgram.js";
import { loadConfig } from "../patchworkConfig.js";
import { compileRecipe } from "./compiler.js";
import {
  getConfigDisabledNames,
  isInstallDirDisabled,
} from "./disabledMarkers.js";
import { parseRecipe } from "./parser.js";

/**
 * Collect AutomationPrograms from installed recipes whose trigger type maps to
 * a native automation hook the bridge already fires.
 *
 * `compileRecipe` (compiler.ts) maps:
 *   - `file_watch` → onFileSave
 *   - `git_hook`   → onGitCommit / onGitPush / onGitPull
 * and THROWS for cron/webhook/manual/chained (those route through the cron
 * scheduler / POST /hooks / CLI / chained runner respectively). The newer
 * `on_file_save` / `on_test_run` trigger types have no compiler case yet, so
 * they are intentionally excluded here and tracked as a follow-up.
 *
 * Before this collector existed, these compiled programs were never registered
 * into AutomationHooks — a recipe with `trigger: { type: file_watch }` parsed,
 * linted, and installed, but never fired (decorative). See
 * docs/dogfood/recipe-dogfood-2026-05-01/C-triggers.md.
 *
 * NOTE: the directory walk here mirrors RecipeScheduler.start()'s candidate
 * enumeration deliberately rather than sharing it — the live cron scheduler is
 * load-bearing and must not regress. Unifying the two walks is a follow-up.
 */
const COMPILABLE_EVENT_TRIGGERS: ReadonlySet<string> = new Set([
  "file_watch",
  "git_hook",
]);

export interface CollectedTriggerPrograms {
  programs: AutomationProgram[];
  /** Names of the recipes whose programs were collected (for logging). */
  recipeNames: string[];
}

interface CollectLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface CollectOptions {
  /**
   * Override the disabled-recipe set. Tests inject this to avoid reading the
   * operator's real ~/.patchwork/config.json (whose disabled list would
   * otherwise silently drop a recipe whose name collides with the dev set).
   */
  disabledRecipes?: ReadonlyArray<string>;
  logger?: CollectLogger;
}

export function collectEventTriggerPrograms(
  recipesDir: string,
  opts: CollectOptions = {},
): CollectedTriggerPrograms {
  const programs: AutomationProgram[] = [];
  const recipeNames: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return { programs, recipeNames };
  }

  const disabled =
    opts.disabledRecipes !== undefined
      ? new Set(opts.disabledRecipes)
      : safeDisabledNames();

  for (const entry of entries) {
    const fullPath = path.join(recipesDir, entry);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    let filePath: string | null = null;
    if (isDir) {
      // Honor the per-install `.disabled` marker (parity with the scheduler).
      if (isInstallDirDisabled(fullPath)) continue;
      filePath = resolveInstallEntrypoint(fullPath);
    } else if (isRecipeFile(entry)) {
      filePath = fullPath;
    }
    if (!filePath) continue;

    const program = compileFromFile(
      filePath,
      disabled,
      recipeNames,
      opts.logger,
    );
    if (program) programs.push(program);
  }

  return { programs, recipeNames };
}

function safeDisabledNames(): Set<string> {
  try {
    return getConfigDisabledNames(loadConfig());
  } catch {
    return new Set();
  }
}

function isRecipeFile(name: string): boolean {
  if (name.endsWith(".permissions.json")) return false;
  return (
    name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".json")
  );
}

/** Resolve an install dir's recipe entrypoint: recipe.json `recipes.main`, else
 *  the first YAML file. Mirrors RecipeScheduler's resolution. */
function resolveInstallEntrypoint(installDir: string): string | null {
  const manifestPath = path.join(installDir, "recipe.json");
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        recipes?: { main?: string };
      };
      if (m.recipes?.main) {
        const candidate = path.join(installDir, m.recipes.main);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Malformed manifest — fall through to first-yaml lookup.
    }
  }
  try {
    const yaml = readdirSync(installDir).find((x) => /\.ya?ml$/i.test(x));
    if (yaml) return path.join(installDir, yaml);
  } catch {
    // Unreadable install dir — skip.
  }
  return null;
}

function compileFromFile(
  filePath: string,
  disabled: Set<string>,
  recipeNames: string[],
  logger?: CollectLogger,
): AutomationProgram | null {
  let recipe: ReturnType<typeof parseRecipe>;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const obj = /\.ya?ml$/i.test(filePath) ? parseYaml(raw) : JSON.parse(raw);
    recipe = parseRecipe(obj);
  } catch (err) {
    // Fail-soft: one malformed recipe must never break startup registration.
    logger?.warn?.(
      `[recipe-triggers] skipped ${path.basename(filePath)} — ${errMsg(err)}`,
    );
    return null;
  }

  if (!COMPILABLE_EVENT_TRIGGERS.has(recipe.trigger.type)) return null;
  if (disabled.has(recipe.name)) {
    logger?.info?.(
      `[recipe-triggers] skipping disabled recipe "${recipe.name}"`,
    );
    return null;
  }

  try {
    const program = compileRecipe(recipe);
    recipeNames.push(recipe.name);
    return program;
  } catch (err) {
    logger?.warn?.(
      `[recipe-triggers] could not compile "${recipe.name}" — ${errMsg(err)}`,
    );
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
