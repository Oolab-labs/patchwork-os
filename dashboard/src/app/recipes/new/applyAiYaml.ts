import { parse as parseYaml } from "yaml";
import { apiPath } from "@/lib/api";

/**
 * Slugify a free-form name into the canonical kebab-case shape that the
 * server, schema, and filesystem all agree on (`^[a-z0-9][a-z0-9-]{0,63}$`).
 * Lowercase, fold whitespace and underscores to dashes, strip leading/
 * trailing dashes. Empty input → empty (caller treats as missing).
 */
export function normalizeRecipeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AiSaveResult =
  | { ok: true; recipeName: string; warnings?: string[] }
  | { ok: false; demoBlocked?: boolean; error: string };

/**
 * Pure save-and-decide helper for the AI Generate flow.
 *
 * Saves the AI-generated YAML verbatim via PUT /api/bridge/recipes/:name and
 * returns a result describing what the caller should do next (redirect, show
 * error, or stash warnings for the edit page). The previous flow funneled
 * generated YAML through a form model that only knew `agent:` steps — any
 * `tool:` step was silently rewritten to an empty agent. This helper is the
 * verbatim path. The body MUST be `{ content: yamlText }` with the YAML
 * unchanged so `tool:` / `parallel:` / `branch:` / `recipe:` steps survive
 * the round-trip (PR #274, regression-tested in applyAiYaml.test.ts).
 *
 * Pure with respect to UI state: takes a fetcher injectable so unit tests
 * can assert the exact request body without spinning up MSW. The caller
 * (page.tsx) wraps this with React state setters and `router.push`.
 */
export async function prepareAndSaveAiRecipe(
  yamlText: string,
  fetcher: typeof fetch = fetch,
): Promise<AiSaveResult> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText) ?? {};
  } catch {
    return { ok: false, error: "Generated YAML is not valid YAML." };
  }

  let recipeName = "";
  if (parsed && typeof parsed === "object") {
    const rawName = (parsed as { name?: unknown }).name;
    if (typeof rawName === "string") {
      recipeName = normalizeRecipeName(rawName);
    }
  }
  if (!recipeName || !RECIPE_NAME_RE.test(recipeName)) {
    return {
      ok: false,
      error:
        "Generated recipe is missing a valid name — regenerate or copy the YAML and create the recipe by hand.",
    };
  }

  let res: Response;
  try {
    res = await fetcher(
      apiPath(`/api/bridge/recipes/${encodeURIComponent(recipeName)}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: yamlText }),
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let data: {
    ok?: boolean;
    error?: string;
    demo?: boolean;
    warnings?: string[];
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, error: "Failed to parse save response." };
  }

  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "Failed to save recipe." };
  }
  if (data.demo) {
    return {
      ok: false,
      demoBlocked: true,
      error:
        "Demo mode — recipe was not persisted. Disable demo mode to save real recipes.",
    };
  }
  return {
    ok: true,
    recipeName,
    ...(data.warnings && data.warnings.length > 0
      ? { warnings: data.warnings }
      : {}),
  };
}
