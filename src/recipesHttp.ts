import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Patchwork recipes HTTP surface — reads installed recipes from disk so the
 * dashboard Recipes page can list what's available. The bridge does not yet
 * run recipes natively; this endpoint is strictly read-only today.
 */

export interface RecipeDraft {
  name: string;
  description?: string;
  trigger: {
    type: "manual" | "webhook" | "schedule";
    path?: string;
    cron?: string;
  };
  steps: Array<{ id: string; kind: "prompt"; prompt: string }>;
}

export function saveRecipe(
  recipesDir: string,
  draft: RecipeDraft,
): { ok: boolean; path?: string; error?: string } {
  const safeName = draft.name.toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  const candidate = path.resolve(recipesDir, `${safeName}.json`);
  const base = path.resolve(recipesDir);
  if (!candidate.startsWith(base + path.sep)) {
    return { ok: false, error: "Invalid path" };
  }
  try {
    mkdirSync(recipesDir, { recursive: true });
    const payload = {
      name: safeName,
      description: draft.description,
      trigger: draft.trigger,
      steps: draft.steps,
      createdAt: Date.now(),
    };
    writeFileSync(candidate, JSON.stringify(payload, null, 2), "utf-8");
    return { ok: true, path: candidate };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RecipeSummary {
  name: string;
  description?: string;
  trigger?: string;
  stepCount: number;
  path: string;
  installedAt: number;
  hasPermissions: boolean;
  source: "user" | "project" | "unknown";
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
      const resolvedRecipesDir = path.resolve(recipesDir);
      let source: RecipeSummary["source"];
      if (
        fullPath.startsWith(resolvedRecipesDir + path.sep) ||
        fullPath === resolvedRecipesDir
      ) {
        source = "user";
      } else if (fullPath.includes(`${path.sep}.patchwork${path.sep}recipes`)) {
        source = "project";
      } else {
        source = "unknown";
      }
      recipes.push({
        name: parsed.name ?? path.basename(f, ".json"),
        description: parsed.description,
        trigger: parsed.trigger?.type,
        stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
        path: fullPath,
        installedAt: stat.mtimeMs,
        hasPermissions,
        source,
      });
    } catch {
      // skip malformed recipe file
    }
  }

  recipes.sort((a, b) => a.name.localeCompare(b.name));
  return { recipesDir, recipes };
}

/**
 * Scan recipes and return the first webhook-triggered recipe whose
 * trigger.path matches the requested path. Returns null on miss.
 * Path match is exact (leading-slash required) — no wildcards yet.
 */
export function findWebhookRecipe(
  recipesDir: string,
  requestPath: string,
): { name: string; path: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return null;
  }
  for (const f of entries) {
    if (!f.endsWith(".json") || f.endsWith(".permissions.json")) continue;
    try {
      const raw = readFileSync(path.join(recipesDir, f), "utf-8");
      const parsed = JSON.parse(raw) as {
        name?: string;
        trigger?: { type?: string; path?: string };
      };
      if (parsed.trigger?.type !== "webhook") continue;
      if (parsed.trigger.path === requestPath) {
        return {
          name: parsed.name ?? path.basename(f, ".json"),
          path: requestPath,
        };
      }
    } catch {
      // skip malformed
    }
  }
  return null;
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
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) return null;

  const candidate = path.resolve(recipesDir, `${safeName}.json`);
  const base = path.resolve(recipesDir);
  if (!candidate.startsWith(base + path.sep)) return null;

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

/**
 * Append a webhook payload to a base prompt so the agent can reference
 * the request body. Payload is JSON-stringified and truncated so a
 * runaway caller can't blow up the orchestrator prompt budget.
 */
export function renderWebhookPrompt(
  basePrompt: string,
  payload: unknown,
): string {
  if (payload === undefined) return basePrompt;
  const MAX = 8_000;
  let body: string;
  try {
    body = JSON.stringify(payload, null, 2);
  } catch {
    body = String(payload);
  }
  if (body.length > MAX) body = `${body.slice(0, MAX)}\n…[truncated]`;
  return `${basePrompt}\n\nWebhook payload:\n\`\`\`json\n${body}\n\`\`\``;
}
