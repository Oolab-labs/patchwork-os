/**
 * Tests for the model-output truncation telemetry on /recipes/generate.
 *
 * Pre-fix the orchestrator silently sliced model output at 64 KB before
 * any parse / refusal-detection pass — masking the boundary case where
 * a `# REFUSED:` marker or the closing ```yaml fence got clipped, which
 * surfaced to the user as the unhelpful "no_yaml_in_output" error
 * (security audit, 2026-05-07).
 *
 * Post-fix, an over-cap output now adds a structured warning to the
 * response so the dashboard can render "model output was truncated"
 * instead of "no YAML found".
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../recipesHttp.js", () => ({
  listInstalledRecipes: vi.fn(),
  loadRecipeContent: vi.fn(),
  saveRecipeContent: vi.fn(),
  saveRecipe: vi.fn(),
  loadRecipePrompt: vi.fn(),
  findYamlRecipePath: vi.fn(),
  findWebhookRecipe: vi.fn(),
  renderWebhookPrompt: vi.fn(),
  lintRecipeContent: vi.fn().mockReturnValue({
    ok: true,
    errors: [],
    warnings: [],
  }),
}));

vi.mock("../patchworkConfig.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  saveConfig: vi.fn(),
  defaultConfigPath: "/tmp/patchwork.json",
}));

vi.mock("../activationMetrics.js", () => ({
  recordRecipeRun: vi.fn(),
}));

vi.mock("../commands/recipe.js", () => ({
  runRecipeDryPlan: vi.fn().mockResolvedValue({}),
}));

function makeServer() {
  return {
    recipesFn: null as unknown,
    loadRecipeContentFn: null as unknown,
    saveRecipeContentFn: null as unknown,
    saveRecipeFn: null as unknown,
    setRecipeEnabledFn: null as unknown,
    runsFn: null as unknown,
    runDetailFn: null as unknown,
    runPlanFn: null as unknown,
    webhookFn: null as unknown,
    runRecipeFn: null as unknown,
    generateRecipeFn: null as unknown,
  };
}

function makeRecipeOrchestrator() {
  return {
    fire: vi.fn(),
    isInFlight: vi.fn().mockReturnValue(false),
    listInFlight: vi.fn().mockReturnValue([]),
  };
}

async function makeOrchestrationWithOutput(output: string) {
  // Existing recipeOrchestration tests intentionally type these mocks
  // loosely (the constructor takes the full Server / Orchestrator
  // shapes; replicating those in tests would balloon the mocks). Cast
  // through `unknown` to satisfy tests:core typecheck without pulling
  // in the full surface.
  const mod = (await import("../recipeOrchestration.js")) as unknown as {
    RecipeOrchestration: new (deps: unknown) => { wireServerFns(): void };
    MAX_MODEL_OUTPUT_BYTES: number;
  };
  const orchestrator = {
    enqueue: vi.fn(),
    runAndWait: vi.fn().mockResolvedValue({
      status: "done",
      output,
      errorMessage: null,
    }),
  };
  const server = makeServer();
  const ro = new mod.RecipeOrchestration({
    server,
    getOrchestrator: () => orchestrator,
    recipeOrchestrator: makeRecipeOrchestrator(),
    recipeRunLog: null,
    workdir: "/tmp/ws",
    logger: {},
  });
  ro.wireServerFns();
  return { server, MAX_MODEL_OUTPUT_BYTES: mod.MAX_MODEL_OUTPUT_BYTES };
}

describe("/recipes/generate — output truncation telemetry", () => {
  it("surfaces a warning when model output exceeds the 64 KB cap (security audit, 2026-05-07)", async () => {
    // Wrap a valid recipe inside a payload larger than the cap so the
    // truncated portion still leaves a parseable YAML block at the top.
    const validRecipe =
      "```yaml\napiVersion: patchwork.sh/v1\nname: ok\ntrigger:\n  type: manual\nsteps:\n  - id: s1\n    agent:\n      prompt: hi\n```\n";
    const huge = validRecipe + "x".repeat(80 * 1024);

    const { server, MAX_MODEL_OUTPUT_BYTES } =
      await makeOrchestrationWithOutput(huge);
    const result = (await (
      server.generateRecipeFn as unknown as (p: string) => Promise<{
        ok: boolean;
        warnings?: string[];
      }>
    )("anything")) as { ok: boolean; warnings?: string[] };

    expect(result.warnings).toBeDefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/truncated|exceeded.*cap/i),
      ]),
    );
    expect(result.warnings?.[0]).toContain(String(MAX_MODEL_OUTPUT_BYTES));
  });

  it("does NOT add the warning when output is within the cap", async () => {
    const small =
      "```yaml\napiVersion: patchwork.sh/v1\nname: ok\ntrigger:\n  type: manual\nsteps:\n  - id: s1\n    agent:\n      prompt: hi\n```";
    const { server } = await makeOrchestrationWithOutput(small);
    const result = (await (
      server.generateRecipeFn as unknown as (p: string) => Promise<{
        ok: boolean;
        warnings?: string[];
      }>
    )("anything")) as { ok: boolean; warnings?: string[] };

    const truncWarnings =
      result.warnings?.filter((w) => /truncated|exceeded/i.test(w)) ?? [];
    expect(truncWarnings).toHaveLength(0);
  });

  it("surfaces the truncation warning even on `no_yaml_in_output` (the most likely truncation outcome)", async () => {
    // A 100 KB blob of garbage with no fenced yaml block. Truncation
    // most often manifests as no_yaml_in_output (the closing fence got
    // clipped past the cap); the warning lets the dashboard render a
    // useful message instead of the generic error.
    const huge = "garbage prose ".repeat(8 * 1024); // ~96 KB
    const { server } = await makeOrchestrationWithOutput(huge);
    const result = (await (
      server.generateRecipeFn as unknown as (p: string) => Promise<{
        ok: boolean;
        error?: string;
        warnings?: string[];
      }>
    )("anything")) as {
      ok: boolean;
      error?: string;
      warnings?: string[];
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_yaml_in_output");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/truncated|exceeded.*cap/i),
      ]),
    );
  });
});
