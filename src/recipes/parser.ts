import { RECIPE_NAME_RE, stripRecipeScope } from "./names.js";
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
  // Marketplace registry recipes may carry a scoped name
  // (`@patchworkos/sprint-review-prep`). Normalize to the bare kebab
  // slug BEFORE the RECIPE_NAME_RE check, so the scoped form installs
  // and is stored on disk under the unscoped slug — a re-load of the
  // persisted recipe (already bare) then passes unchanged.
  const name = stripRecipeScope(requireString(r, "name"));
  // Enforce the canonical recipe-name shape at the parse boundary. Without
  // this, `installRecipeFromFile` would `path.join(recipesDir, ${name}.json)`
  // with attacker-controlled `name` (registry recipe / bundle install path)
  // and `../../../etc/cron.d/pwn` would escape the recipes dir. Audit 2026-05-17.
  // `recipesHttp` already enforces this regex at its own boundaries; this
  // closes the gap on the install path used by `recipes/install` + bundle install.
  if (!RECIPE_NAME_RE.test(name)) {
    throw new RecipeParseError(
      `name must match ${RECIPE_NAME_RE} (kebab-case, 1-64 chars, alphanumeric or hyphen, starts with [a-z0-9])`,
      ["name"],
    );
  }
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
    case "chained":
      // Chained recipes route to the ChainedRecipeRunner (dispatchRecipe).
      // No required trigger fields — step-level awaits/parallel/vars drive
      // execution. Parity with validateRecipeDefinition + the JSON schema
      // so a recipe that lints + runs can also be installed.
      return { type: "chained" };
    case "on_file_save":
      // Runtime file-save trigger. `glob`/`filter` are optional; preserve
      // them when present so the on-disk JSON round-trip keeps the author's
      // intent.
      return {
        type: "on_file_save",
        ...(typeof t.glob === "string" ? { glob: t.glob } : {}),
        ...(typeof t.filter === "string" ? { filter: t.filter } : {}),
      };
    case "on_test_run":
      // Runtime test-run trigger. `filter` ("any" | "failure" |
      // "pass-after-fail") is optional; preserve when present.
      return {
        type: "on_test_run",
        ...(typeof t.filter === "string" ? { filter: t.filter } : {}),
      };
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

  // Modern object form (the shape used by every bundled template, the
  // canonical schemas/recipe.v1.json, validation.ts, and yamlRunner.ts):
  //   agent: { prompt, into?, tools?, risk?, kind?, reviews?, … }
  // Read prompt + tools + risk from the nested object and map `into` →
  // the internal `output` field. Any extra agent fields (kind, reviews,
  // model, driver, …) are preserved by yamlRunner via `step.agent` but
  // aren't in the internal AgentStep type — the compile/install path
  // doesn't need them, so dropping them here is fine.
  if (s.agent && typeof s.agent === "object" && !Array.isArray(s.agent)) {
    const agent = s.agent as Record<string, unknown>;
    const prompt = requireString(agent, "prompt");
    const into =
      typeof s.into === "string"
        ? s.into
        : typeof agent.into === "string"
          ? agent.into
          : undefined;
    return {
      id,
      agent: true,
      prompt,
      tools: Array.isArray(agent.tools) ? (agent.tools as string[]) : undefined,
      risk: (agent.risk ?? s.risk) as Step["risk"],
      output: typeof s.output === "string" ? s.output : into,
    };
  }

  // Modern top-level form for tool steps (no `agent` discriminator):
  //   tool: "gmail.fetch_unread"
  //   params: { … }
  //   into: "step_output"
  if (s.agent === undefined && typeof s.tool === "string") {
    return {
      id,
      agent: false,
      tool: s.tool,
      params:
        typeof s.params === "object" && s.params !== null
          ? (s.params as Record<string, unknown>)
          : {},
      risk: s.risk as Step["risk"],
      output:
        typeof s.output === "string"
          ? s.output
          : typeof s.into === "string"
            ? s.into
            : undefined,
    };
  }

  // Compound step shapes — parallel groups, nested recipes, chains,
  // each-loops. parser.ts predates these and the internal Step union
  // doesn't model them, but yamlRunner / chainedRunner read them
  // straight from the raw object. Pass them through with the extra
  // fields preserved (JSON.stringify in installer.ts:88 keeps every
  // field) so the install path doesn't reject the entire recipe.
  // Compile is bypassed for cron/webhook/manual triggers (which is
  // what every parallel-using recipe in the registry currently uses),
  // so the dummy `agent: false` discriminator never reaches the
  // compiler — it only satisfies TypeScript's union narrowing.
  if (
    Array.isArray(s.parallel) ||
    typeof s.recipe === "string" ||
    typeof s.chain === "string" ||
    typeof s.each === "string"
  ) {
    return {
      ...(s as Record<string, unknown>),
      id,
      agent: false,
      tool: "__compound__",
      params: {},
      risk: s.risk as Step["risk"],
    } as unknown as Step;
  }

  // Legacy boolean discriminator — kept for backward compat with any
  // older recipes still in the wild that use `agent: true / false` as
  // the agent/tool selector with flat `prompt` / `tool` siblings.
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
  throw new RecipeParseError(
    "step must declare `agent: { prompt }`, `tool: <name>`, or (legacy) `agent: true|false`",
    [...path, "agent"],
  );
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
      // Object.hasOwn — `in` walks the prototype chain, which would expose
      // Object.prototype members (toString, constructor, etc.) to attacker-
      // controllable template paths.
      if (cur && typeof cur === "object" && Object.hasOwn(cur as object, p)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return "";
      }
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}
