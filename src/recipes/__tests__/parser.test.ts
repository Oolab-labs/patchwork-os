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
});
