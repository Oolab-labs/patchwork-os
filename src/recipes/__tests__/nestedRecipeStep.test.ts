import { describe, expect, it } from "vitest";
import {
  calculateNestedRisk,
  formatNestedOutput,
  mockNestedRecipe,
  resolveNestedVars,
  validateNestedRecipe,
} from "../nestedRecipeStep.js";
import { createOutputRegistry } from "../outputRegistry.js";

const baseConfig = {
  recipe: "child-recipe",
  vars: {},
  id: "step1",
};

const baseContext = {
  parentRegistry: createOutputRegistry(),
  parentEnv: {},
  recipeMaxDepth: 3,
  currentDepth: 0,
  dryRun: false,
};

describe("resolveNestedVars", () => {
  it("resolves static strings unchanged", () => {
    const { resolved, errors } = resolveNestedVars(
      { key: "hello" },
      { steps: {}, env: {} },
    );
    expect(errors).toHaveLength(0);
    expect(resolved.key).toBe("hello");
  });

  it("resolves env templates", () => {
    const { resolved, errors } = resolveNestedVars(
      { path: "{{env.HOME}}" },
      { steps: {}, env: { HOME: "/home/user" } },
    );
    expect(errors).toHaveLength(0);
    expect(resolved.path).toBe("/home/user");
  });

  it("resolves step data templates", () => {
    const { resolved } = resolveNestedVars(
      { url: "{{steps.fetch.data.url}}" },
      {
        steps: {
          fetch: {
            status: "success" as const,
            data: { url: "https://example.com" },
          },
        },
        env: {},
      },
    );
    expect(resolved.url).toBe("https://example.com");
  });

  it("returns error and empty string for invalid template", () => {
    const { resolved, errors } = resolveNestedVars(
      { bad: "{{invalid syntax!}}" },
      { steps: {}, env: {} },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(resolved.bad).toBe("");
  });

  it("returns empty string for missing env var (not an error)", () => {
    const { resolved, errors } = resolveNestedVars(
      { val: "{{env.MISSING}}" },
      { steps: {}, env: {} },
    );
    expect(errors).toHaveLength(0);
    expect(resolved.val).toBe("");
  });

  it("handles empty vars object", () => {
    const { resolved, errors } = resolveNestedVars({}, { steps: {}, env: {} });
    expect(errors).toHaveLength(0);
    expect(resolved).toEqual({});
  });
});

describe("validateNestedRecipe", () => {
  it("passes when depth within limit", () => {
    const r = validateNestedRecipe(baseConfig, {
      ...baseContext,
      currentDepth: 0,
      recipeMaxDepth: 3,
    });
    expect(r.valid).toBe(true);
  });

  it("passes when depth equals max (maxDepth:3 allows depth 0→1→2→3)", () => {
    const r = validateNestedRecipe(baseConfig, {
      ...baseContext,
      currentDepth: 3,
      recipeMaxDepth: 3,
    });
    expect(r.valid).toBe(true);
  });

  it("fails when depth exceeds max", () => {
    const r = validateNestedRecipe(baseConfig, {
      ...baseContext,
      currentDepth: 4,
      recipeMaxDepth: 3,
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/depth limit/);
  });

  it("fails when recipe name is empty string", () => {
    const r = validateNestedRecipe({ ...baseConfig, recipe: "" }, baseContext);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/required/);
  });

  it("includes step id and recipe name in depth error", () => {
    const r = validateNestedRecipe(
      { ...baseConfig, id: "my-step", recipe: "child" },
      { ...baseContext, currentDepth: 4, recipeMaxDepth: 3 },
    );
    expect(r.error).toContain("my-step");
    expect(r.error).toContain("child");
  });
});

describe("calculateNestedRisk", () => {
  it("returns low when both undefined", () => {
    expect(calculateNestedRisk(undefined, undefined)).toBe("low");
  });

  it("escalates to child risk when higher", () => {
    expect(calculateNestedRisk("low", "high")).toBe("high");
  });

  it("keeps parent risk when higher", () => {
    expect(calculateNestedRisk("high", "low")).toBe("high");
  });

  it("returns medium when both medium", () => {
    expect(calculateNestedRisk("medium", "medium")).toBe("medium");
  });

  it("escalates low → medium", () => {
    expect(calculateNestedRisk("low", "medium")).toBe("medium");
  });
});

describe("formatNestedOutput", () => {
  it("formats success result", () => {
    const out = formatNestedOutput(
      { success: true, data: "payload", childOutputs: { step1: "val" } },
      baseConfig,
    );
    expect(out.stepId).toBe("step1");
    expect(out.output.status).toBe("success");
    expect((out.output.data as Record<string, unknown>).recipe).toBe(
      "child-recipe",
    );
  });

  it("formats error result", () => {
    const out = formatNestedOutput(
      { success: false, error: "boom" },
      baseConfig,
    );
    expect(out.output.status).toBe("error");
    expect((out.output.data as Record<string, unknown>).error).toBe("boom");
  });

  it("uses output field as stepId when provided", () => {
    const out = formatNestedOutput(
      { success: true },
      { ...baseConfig, output: "custom-key" },
    );
    expect(out.stepId).toBe("custom-key");
  });

  it("falls back to id when output not set", () => {
    const out = formatNestedOutput({ success: true }, baseConfig);
    expect(out.stepId).toBe("step1");
  });
});

describe("mockNestedRecipe", () => {
  it("returns dry-run result for valid config", async () => {
    const r = await mockNestedRecipe(baseConfig, {
      ...baseContext,
      dryRun: true,
    });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).dryRun).toBe(true);
    expect((r.data as Record<string, unknown>).recipe).toBe("child-recipe");
  });

  it("includes resolved vars in dry-run result", async () => {
    const registry = createOutputRegistry();
    const r = await mockNestedRecipe(
      { ...baseConfig, vars: { key: "{{env.FOO}}" } },
      {
        ...baseContext,
        parentEnv: { FOO: "bar" },
        parentRegistry: registry,
        dryRun: true,
      },
    );
    expect((r.data as Record<string, unknown>).resolvedVars).toEqual({
      key: "bar",
    });
  });

  it("fails on depth exceeded", async () => {
    const r = await mockNestedRecipe(baseConfig, {
      ...baseContext,
      currentDepth: 4,
      recipeMaxDepth: 3,
      dryRun: true,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/depth/);
  });

  it("fails on template error in vars", async () => {
    const r = await mockNestedRecipe(
      { ...baseConfig, vars: { bad: "{{invalid syntax!}}" } },
      { ...baseContext, dryRun: true },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Template errors/);
  });

  it("shows wouldExecuteAtDepth", async () => {
    const r = await mockNestedRecipe(baseConfig, {
      ...baseContext,
      currentDepth: 1,
      dryRun: true,
    });
    expect((r.data as Record<string, unknown>).wouldExecuteAtDepth).toBe(2);
  });
});
