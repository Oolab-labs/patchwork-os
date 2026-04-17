import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Patchwork recipes HTTP surface — reads installed recipes from disk so the
 * dashboard Recipes page can list what's available. The bridge does not yet
 * run recipes natively; this endpoint is strictly read-only today.
 */

export interface RecipeSummary {
  name: string;
  description?: string;
  trigger?: string;
  stepCount: number;
  path: string;
  installedAt: number;
  hasPermissions: boolean;
}

export interface ListRecipesResult {
  recipesDir: string;
  recipes: RecipeSummary[];
}

export function listInstalledRecipes(recipesDir: string): ListRecipesResult {
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return { recipesDir, recipes: [] };
  }

  const recipes: RecipeSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json") || f.endsWith(".permissions.json")) continue;
    const fullPath = path.join(recipesDir, f);
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        name?: string;
        description?: string;
        trigger?: { type?: string };
        steps?: unknown[];
      };
      const stat = statSync(fullPath);
      const permsPath = `${fullPath}.permissions.json`;
      let hasPermissions = false;
      try {
        statSync(permsPath);
        hasPermissions = true;
      } catch {
        // no permissions sidecar
      }
      recipes.push({
        name: parsed.name ?? path.basename(f, ".json"),
        description: parsed.description,
        trigger: parsed.trigger?.type,
        stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
        path: fullPath,
        installedAt: stat.mtimeMs,
        hasPermissions,
      });
    } catch {
      // skip malformed recipe file
    }
  }

  recipes.sort((a, b) => a.name.localeCompare(b.name));
  return { recipesDir, recipes };
}

/**
 * Load a recipe by name and render a plain-text prompt suitable for
 * enqueueing to the Claude orchestrator. Returns null when the recipe
 * can't be found.
 */
export function loadRecipePrompt(
  recipesDir: string,
  name: string,
): { prompt: string; path: string } | null {
  const candidate = path.join(recipesDir, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(candidate, "utf-8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as {
    name?: string;
    description?: string;
    steps?: Array<{
      id?: string;
      kind?: string;
      prompt?: string;
      tool?: string;
      description?: string;
    }>;
  };
  const lines: string[] = [];
  lines.push(`You are running the Patchwork recipe "${parsed.name ?? name}".`);
  if (parsed.description)
    lines.push(`\nRecipe description: ${parsed.description}`);
  if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    lines.push(
      "\nCarry out each step in order and report progress after every step:\n",
    );
    for (let i = 0; i < parsed.steps.length; i++) {
      const s = parsed.steps[i];
      if (!s) continue;
      const label = s.id ?? `step-${i + 1}`;
      const body =
        s.prompt ??
        s.description ??
        (s.tool ? `Use tool ${s.tool}.` : "(no description)");
      lines.push(`${i + 1}. [${label}] ${body}`);
    }
  }
  lines.push(
    "\nWhen finished, print a one-line summary prefixed with 'RECIPE DONE:'.",
  );
  return { prompt: lines.join("\n"), path: candidate };
}
