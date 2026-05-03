/**
 * Tests for RecipeOrchestration — RED phase (module doesn't exist yet).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// These imports will fail until src/recipeOrchestration.ts exists.
let RecipeOrchestration: any;
let RecipeOrchestrationModule: any;

beforeEach(async () => {
  RecipeOrchestrationModule = await import("../recipeOrchestration.js");
  RecipeOrchestration = RecipeOrchestrationModule.RecipeOrchestration;
});

// ---------------------------------------------------------------------------
// Helpers — minimal mocks
// ---------------------------------------------------------------------------

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
  };
}

function makeRecipeOrchestrator(overrides: Record<string, unknown> = {}) {
  return {
    fire: vi.fn().mockResolvedValue({ ok: true, taskId: "t1", name: "foo" }),
    isInFlight: vi.fn().mockReturnValue(false),
    listInFlight: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock recipesHttp so tests don't hit the filesystem
// ---------------------------------------------------------------------------
vi.mock("../recipesHttp.js", () => ({
  listInstalledRecipes: vi.fn(),
  loadRecipeContent: vi.fn(),
  saveRecipeContent: vi.fn(),
  saveRecipe: vi.fn(),
  loadRecipePrompt: vi.fn(),
  findYamlRecipePath: vi.fn(),
  findWebhookRecipe: vi.fn(),
  renderWebhookPrompt: vi.fn(),
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

// ---------------------------------------------------------------------------

describe("RecipeOrchestration", () => {
  it("wireServerFns() — recipesFn lists installed recipes", async () => {
    const { listInstalledRecipes } = await import("../recipesHttp.js");
    vi.mocked(listInstalledRecipes).mockReturnValue([{ name: "a" }] as never);

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => null,
      recipeOrchestrator: makeRecipeOrchestrator(),
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: {},
    });
    ro.wireServerFns();

    const result = (server.recipesFn as any)();
    expect(result).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "a" })]),
    );
  });

  it("wireServerFns() — runRecipeFn returns error when orchestrator unavailable", async () => {
    const { loadRecipePrompt } = await import("../recipesHttp.js");
    vi.mocked(loadRecipePrompt).mockReturnValue(null as never);

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => null,
      recipeOrchestrator: makeRecipeOrchestrator(),
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: {},
    });
    ro.wireServerFns();

    const result = await (server.runRecipeFn as any)("foo");
    expect(result).toMatchObject({ ok: false });
  });

  it("wireServerFns() — runRecipeFn enqueues JSON recipe", async () => {
    const { loadRecipePrompt } = await import("../recipesHttp.js");
    vi.mocked(loadRecipePrompt).mockReturnValue({ prompt: "do it" } as never);

    const mockOrchestrator = { enqueue: vi.fn().mockReturnValue("tid") };

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => mockOrchestrator,
      recipeOrchestrator: makeRecipeOrchestrator(),
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: {},
    });
    ro.wireServerFns();

    const result = await (server.runRecipeFn as any)("foo");
    expect(result).toMatchObject({ ok: true, taskId: "tid" });
  });

  it("wireServerFns() — runRecipeFn fires YAML recipe when no JSON found", async () => {
    const { loadRecipePrompt, findYamlRecipePath } = await import(
      "../recipesHttp.js"
    );
    vi.mocked(loadRecipePrompt).mockReturnValue(null as never);
    vi.mocked(findYamlRecipePath).mockReturnValue("/r/foo.yaml" as never);

    const mockOrchestrator = { enqueue: vi.fn(), runAndWait: vi.fn() };
    const fireStub = vi
      .fn()
      .mockResolvedValue({ ok: true, taskId: "y1", name: "foo" });
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => mockOrchestrator,
      recipeOrchestrator: recipeOrch,
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: {},
    });
    ro.wireServerFns();

    await (server.runRecipeFn as any)("foo");
    expect(fireStub).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/r/foo.yaml" }),
    );
  });

  it("wireServerFns() — runsFn returns empty array when no runLog", () => {
    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => null,
      recipeOrchestrator: makeRecipeOrchestrator(),
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: {},
    });
    ro.wireServerFns();

    const result = (server.runsFn as any)({});
    expect(result).toEqual([]);
  });

  it("fireYamlRecipe() — returns {ok:false,error} when recipeOrchestrator.fire() rejects", async () => {
    const fireStub = vi.fn().mockRejectedValue(new Error("boom"));
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
    const mockOrchestrator = { runAndWait: vi.fn() };

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => mockOrchestrator,
      recipeOrchestrator: recipeOrch,
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: { warn: vi.fn() },
    });

    const result = await ro.fireYamlRecipe({
      filePath: "/r/foo.yaml",
      name: "foo",
      taskIdPrefix: "yaml-recipe-foo",
      triggerSourceSuffix: "recipe:foo",
      logLabel: '"foo"',
    });
    expect(result).toMatchObject({ ok: false, error: "boom" });
  });

  it("buildScheduler() — returns a RecipeScheduler instance", () => {
    const scheduler = RecipeOrchestration.buildScheduler({
      recipesDir: "/tmp/recipes",
      runRecipeFn: vi.fn(),
      enqueue: vi.fn().mockReturnValue("t1"),
      logger: {},
    });
    // Should be a RecipeScheduler (has a start() method)
    expect(typeof scheduler.start).toBe("function");
  });
});
