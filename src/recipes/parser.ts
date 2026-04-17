import type { Recipe, Step, Trigger } from "./schema.js";

/**
 * parseRecipe — validates a raw object and returns a typed Recipe.
 *
 * Phase-1 scope: JSON in, Recipe out. YAML support lands when a real recipe
 * needs it (add `yaml` dep + pre-parse step; schema unchanged).
 */

export class RecipeParseError extends Error {
  constructor(
    message: string,
    public path: string[] = [],
  ) {
    super(path.length ? `${path.join(".")}: ${message}` : message);
    this.name = "RecipeParseError";
  }
}

export function parseRecipe(raw: unknown): Recipe {
  if (typeof raw !== "object" || raw === null) {
    throw new RecipeParseError("recipe must be an object");
  }
  const r = raw as Record<string, unknown>;
  const name = requireString(r, "name");
  const version = requireString(r, "version");
  const trigger = parseTrigger(r.trigger);
  const stepsRaw = r.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new RecipeParseError("steps must be a non-empty array", ["steps"]);
  }
  const ids = new Set<string>();
  const steps: Step[] = stepsRaw.map((s, i) => {
    const step = parseStep(s, ["steps", String(i)]);
    if (ids.has(step.id)) {
      throw new RecipeParseError(`duplicate step id '${step.id}'`, [
        "steps",
        String(i),
      ]);
    }
    ids.add(step.id);
    return step;
  });

  return {
    name,
    version,
    description: typeof r.description === "string" ? r.description : undefined,
    trigger,
    context: Array.isArray(r.context)
      ? (r.context as Recipe["context"])
      : undefined,
    steps,
    on_error:
      typeof r.on_error === "object" && r.on_error !== null
        ? (r.on_error as Recipe["on_error"])
        : undefined,
  };
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v)
    throw new RecipeParseError(`missing or empty '${key}'`, [key]);
  return v;
}

function parseTrigger(raw: unknown): Trigger {
  if (typeof raw !== "object" || raw === null)
    throw new RecipeParseError("trigger required", ["trigger"]);
  const t = raw as Record<string, unknown>;
  switch (t.type) {
    case "webhook":
      if (typeof t.path !== "string" || !t.path.startsWith("/"))
        throw new RecipeParseError("webhook.path must start with /", [
          "trigger",
          "path",
        ]);
      return { type: "webhook", path: t.path };
    case "cron":
      if (typeof t.schedule !== "string" || !t.schedule.trim())
        throw new RecipeParseError("cron.schedule required", [
          "trigger",
          "schedule",
        ]);
      return { type: "cron", schedule: t.schedule };
    case "file_watch":
      if (!Array.isArray(t.patterns) || t.patterns.length === 0)
        throw new RecipeParseError("file_watch.patterns required", [
          "trigger",
          "patterns",
        ]);
      return {
        type: "file_watch",
        patterns: (t.patterns as string[]).filter((p) => typeof p === "string"),
      };
    case "git_hook":
      if (
        t.event !== "post-commit" &&
        t.event !== "pre-push" &&
        t.event !== "post-merge"
      )
        throw new RecipeParseError("invalid git_hook.event", [
          "trigger",
          "event",
        ]);
      return { type: "git_hook", event: t.event };
    case "manual":
      return { type: "manual" };
    default:
      throw new RecipeParseError(`unknown trigger type '${String(t.type)}'`, [
        "trigger",
        "type",
      ]);
  }
}

function parseStep(raw: unknown, path: string[]): Step {
  if (typeof raw !== "object" || raw === null)
    throw new RecipeParseError("step must be an object", path);
  const s = raw as Record<string, unknown>;
  const id = requireString(s, "id");
  if (s.agent === true) {
    const prompt = requireString(s, "prompt");
    return {
      id,
      agent: true,
      prompt,
      tools: Array.isArray(s.tools) ? (s.tools as string[]) : undefined,
      risk: s.risk as Step["risk"],
      output: typeof s.output === "string" ? s.output : undefined,
    };
  }
  if (s.agent === false) {
    const tool = requireString(s, "tool");
    return {
      id,
      agent: false,
      tool,
      params:
        typeof s.params === "object" && s.params !== null
          ? (s.params as Record<string, unknown>)
          : {},
      risk: s.risk as Step["risk"],
      output: typeof s.output === "string" ? s.output : undefined,
    };
  }
  throw new RecipeParseError("step.agent must be true or false", [
    ...path,
    "agent",
  ]);
}

/**
 * Render `{{ path.to.value }}` templates against a flat context map.
 * Whitespace-tolerant. Missing keys render as "". Does NOT touch double-brace
 * inside quoted strings specially — this is a minimal renderer by design.
 */
export function renderTemplate(
  input: string,
  context: Record<string, unknown>,
): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.split(".").map((s) => s.trim());
    let cur: unknown = context;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as object)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return "";
      }
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}
