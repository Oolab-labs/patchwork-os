import { describe, expect, it } from "vitest";
import { parseRecipe, RecipeParseError, renderTemplate } from "../parser.js";

const VALID = {
  name: "sentry-autofix",
  version: "1.0",
  description: "auto-fix",
  trigger: { type: "webhook", path: "/hooks/sentry" },
  steps: [
    { id: "analyze", agent: true, prompt: "root cause?", output: "analysis" },
    {
      id: "notify",
      agent: false,
      tool: "send_message",
      params: { text: "done" },
    },
  ],
};

describe("parseRecipe", () => {
  it("accepts a valid recipe", () => {
    const r = parseRecipe(VALID);
    expect(r.name).toBe("sentry-autofix");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]).toMatchObject({ id: "analyze", agent: true });
    expect(r.steps[1]).toMatchObject({ id: "notify", agent: false });
  });

  it("rejects missing name", () => {
    expect(() => parseRecipe({ ...VALID, name: "" })).toThrow(RecipeParseError);
  });

  // Regression: parseRecipe (the installer's normalizer) silently dropped the
  // recipe-level `budget`, so a recipe round-tripped through it lost its token
  // budget and RunBudget(recipe.budget) enforced nothing. Pass it through.
  it("preserves the recipe-level budget", () => {
    const r = parseRecipe({
      ...VALID,
      budget: { tokensMax: 50000, onBreach: "warn" },
    });
    expect(r.budget).toEqual({ tokensMax: 50000, onBreach: "warn" });
  });

  it("leaves budget undefined when absent (no synthetic policy)", () => {
    expect(parseRecipe(VALID).budget).toBeUndefined();
  });

  // Regression: parseRecipe hard-rejected a version-less recipe with
  // "missing or empty 'version'", but the JSON schema marks version
  // optional with default "1.0.0" and neither validateRecipeDefinition
  // nor the yaml runner check it. A version-less recipe linted + ran but
  // failed at install with a confusing error. version is optional and
  // defaults to "1.0.0" at the parse boundary.
  describe("version is optional (parity with schema default)", () => {
    it("defaults version to 1.0.0 when omitted", () => {
      const { version: _omit, ...noVersion } = VALID;
      const r = parseRecipe(noVersion);
      expect(r.version).toBe("1.0.0");
    });

    it("defaults version to 1.0.0 when empty", () => {
      const r = parseRecipe({ ...VALID, version: "" });
      expect(r.version).toBe("1.0.0");
    });

    it("preserves an explicit version string", () => {
      const r = parseRecipe({ ...VALID, version: "2.3.1" });
      expect(r.version).toBe("2.3.1");
    });
  });

  it("rejects empty steps", () => {
    expect(() => parseRecipe({ ...VALID, steps: [] })).toThrow(/non-empty/);
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      parseRecipe({
        ...VALID,
        steps: [
          { id: "x", agent: true, prompt: "a" },
          { id: "x", agent: false, tool: "t", params: {} },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });

  it("rejects bad trigger type", () => {
    expect(() =>
      parseRecipe({ ...VALID, trigger: { type: "telepathy" } }),
    ).toThrow(/unknown trigger/);
  });

  it("rejects webhook path without leading slash", () => {
    expect(() =>
      parseRecipe({ ...VALID, trigger: { type: "webhook", path: "nope" } }),
    ).toThrow(/must start with \//);
  });

  it("accepts every trigger type", () => {
    for (const trigger of [
      { type: "webhook", path: "/x" },
      { type: "cron", schedule: "0 9 * * 1-5" },
      { type: "file_watch", patterns: ["**/*.ts"] },
      { type: "git_hook", event: "post-commit" },
      { type: "manual" },
    ]) {
      const r = parseRecipe({ ...VALID, trigger });
      expect(r.trigger.type).toBe(trigger.type);
    }
  });

  // Regression (audit 2026-06-03 HIGH #9): the JSON schema documents the cron
  // expression field as `at`, and validateRecipeDefinition reads `trigger.at`
  // (after normalization), but parseRecipe — the install path — only read
  // `trigger.schedule` and threw `cron.schedule required`. A schema-compliant
  // recipe using `at:` passed `recipe lint` but failed `recipe install`.
  it("accepts cron `at` as an alias for `schedule`", () => {
    const r = parseRecipe({
      ...VALID,
      trigger: { type: "cron", at: "0 9 * * *" },
    });
    expect(r.trigger.type).toBe("cron");
    expect((r.trigger as { schedule: string }).schedule).toBe("0 9 * * *");
  });

  it("still requires a cron expression (neither schedule nor at)", () => {
    expect(() => parseRecipe({ ...VALID, trigger: { type: "cron" } })).toThrow(
      /cron\.schedule/,
    );
  });

  // Regression: parser.ts rejected `chained`, `on_file_save`, and
  // `on_test_run` even though validateRecipeDefinition, the JSON schema,
  // and the runtime (chainedRunner / dispatchRecipe / yamlRunner) all
  // support them. A recipe that lints + runs could NOT be installed
  // because the install path goes through parseRecipe.
  describe("runtime trigger types accepted by parser (parity with validation/schema)", () => {
    it("accepts a chained trigger", () => {
      const r = parseRecipe({ ...VALID, trigger: { type: "chained" } });
      expect(r.trigger.type).toBe("chained");
    });

    it("accepts an on_file_save trigger and preserves glob", () => {
      const r = parseRecipe({
        ...VALID,
        trigger: { type: "on_file_save", glob: "**/*.ts" },
      });
      expect(r.trigger.type).toBe("on_file_save");
      const serialized = JSON.parse(JSON.stringify(r));
      expect(serialized.trigger.glob).toBe("**/*.ts");
    });

    it("accepts an on_test_run trigger and preserves filter", () => {
      const r = parseRecipe({
        ...VALID,
        trigger: { type: "on_test_run", filter: "failure" },
      });
      expect(r.trigger.type).toBe("on_test_run");
      const serialized = JSON.parse(JSON.stringify(r));
      expect(serialized.trigger.filter).toBe("failure");
    });
  });

  // Regression: the marketplace install flow was broken because parser.ts
  // only accepted the legacy boolean discriminator (`agent: true | false`)
  // while the canonical schema, the runtime executor, every bundled
  // template, and the entire patchworkos/recipes registry use the
  // object form. Calling Install on the FEATURED recipe threw
  // "step.agent must be true or false" because of parser.ts mismatch.
  describe("modern object-form agent step (registry / yamlRunner shape)", () => {
    it("accepts agent: { prompt, into } as object-form agent step", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [
          {
            id: "compose",
            agent: { prompt: "draft a brief", into: "brief" },
          },
        ],
      });
      expect(r.steps[0]).toMatchObject({
        id: "compose",
        agent: true,
        prompt: "draft a brief",
        output: "brief", // `into` maps to internal `output`
      });
    });

    it("accepts agent: { prompt, tools } and preserves tools", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [
          {
            id: "research",
            agent: { prompt: "look it up", tools: ["search", "fetch"] },
          },
        ],
      });
      expect(r.steps[0]).toMatchObject({
        id: "research",
        agent: true,
        prompt: "look it up",
        tools: ["search", "fetch"],
      });
    });

    it("rejects object-form agent without prompt", () => {
      expect(() =>
        parseRecipe({
          ...VALID,
          steps: [{ id: "x", agent: { into: "out" } }],
        }),
      ).toThrow(RecipeParseError);
    });
  });

  describe("modern top-level tool step (no `agent` discriminator)", () => {
    it("accepts tool: 'X' at the top level with params", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [
          {
            id: "send",
            tool: "slack.post_message",
            params: { channel: "#wins", text: "shipped" },
            into: "post_id",
          },
        ],
      });
      expect(r.steps[0]).toMatchObject({
        id: "send",
        agent: false,
        tool: "slack.post_message",
        params: { channel: "#wins", text: "shipped" },
        output: "post_id", // `into` maps to internal `output`
      });
    });

    it("defaults params to empty object when omitted", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [{ id: "noop", tool: "ping" }],
      });
      expect(r.steps[0]).toMatchObject({
        id: "noop",
        agent: false,
        tool: "ping",
        params: {},
      });
    });
  });

  describe("compound step shapes pass through (parallel, nested recipe, chain, each)", () => {
    it("accepts a parallel-group step and preserves substeps in JSON output", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [
          {
            id: "fetch_all",
            parallel: [
              { id: "a", tool: "gmail.fetch", params: {} },
              { id: "b", tool: "linear.list", params: {} },
            ],
          },
        ],
      });
      // JSON-stringify is the on-disk format — every field of the raw
      // step survives, including `parallel` even though it's not in the
      // internal Step type.
      const serialized = JSON.parse(JSON.stringify(r));
      expect(serialized.steps[0].id).toBe("fetch_all");
      expect(serialized.steps[0].parallel).toHaveLength(2);
      expect(serialized.steps[0].parallel[0].tool).toBe("gmail.fetch");
    });

    it("accepts a nested recipe step (recipe: <name>)", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [{ id: "subflow", recipe: "shared/triage" }],
      });
      const serialized = JSON.parse(JSON.stringify(r));
      expect(serialized.steps[0].recipe).toBe("shared/triage");
    });

    it("accepts a chain step (chain: <name>)", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [{ id: "next", chain: "next-recipe" }],
      });
      const serialized = JSON.parse(JSON.stringify(r));
      expect(serialized.steps[0].chain).toBe("next-recipe");
    });
  });

  describe("legacy boolean discriminator still works", () => {
    it("still accepts agent: true with flat prompt", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [{ id: "x", agent: true, prompt: "hi" }],
      });
      expect(r.steps[0]).toMatchObject({ id: "x", agent: true, prompt: "hi" });
    });

    it("still accepts agent: false with flat tool", () => {
      const r = parseRecipe({
        ...VALID,
        steps: [{ id: "x", agent: false, tool: "t", params: {} }],
      });
      expect(r.steps[0]).toMatchObject({ id: "x", agent: false, tool: "t" });
    });
  });
});

describe("renderTemplate", () => {
  it("renders nested paths", () => {
    expect(
      renderTemplate("Error: {{ trigger.payload.title }}", {
        trigger: { payload: { title: "boom" } },
      }),
    ).toBe("Error: boom");
  });

  it("renders missing paths as empty", () => {
    expect(renderTemplate("hi {{ nope.x }}!", {})).toBe("hi !");
  });

  it("tolerates surrounding whitespace", () => {
    expect(renderTemplate("{{   a.b   }}", { a: { b: "ok" } })).toBe("ok");
  });

  it("leaves non-template text untouched", () => {
    expect(renderTemplate("no templates here", {})).toBe("no templates here");
  });

  it("does not walk Object.prototype for top-level keys", () => {
    // Without the Object.hasOwn guard, `"toString" in {}` is true and
    // `{}["toString"]` returns Object.prototype.toString — a function whose
    // source would leak into recipe output via String() coercion.
    expect(renderTemplate("{{ toString }}", {})).toBe("");
    expect(renderTemplate("{{ constructor }}", {})).toBe("");
    expect(renderTemplate("{{ valueOf }}", {})).toBe("");
    expect(renderTemplate("{{ hasOwnProperty }}", {})).toBe("");
  });

  it("does not walk Object.prototype on nested paths", () => {
    expect(renderTemplate("{{ trigger.constructor }}", { trigger: {} })).toBe(
      "",
    );
    expect(
      renderTemplate("{{ trigger.payload.toString }}", {
        trigger: { payload: { other: "x" } },
      }),
    ).toBe("");
  });
});
