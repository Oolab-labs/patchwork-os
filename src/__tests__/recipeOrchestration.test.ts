/**
 * Tests for RecipeOrchestration — RED phase (module doesn't exist yet).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

vi.mock("../recipes/yamlRunner.js", () => ({
  buildChainedDeps: vi.fn().mockReturnValue({}),
  dispatchRecipe: vi.fn().mockResolvedValue({ success: true, summary: {} }),
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

  it("wireServerFns() — runRecipeFn rejects missing required vars before firing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ro-test-"));
    const ymlPath = join(tmpDir, "bar.yaml");
    writeFileSync(
      ymlPath,
      "trigger:\n  inputs:\n    - name: issueId\n      required: true\nsteps: []\n",
    );
    try {
      const { loadRecipePrompt, findYamlRecipePath } = await import(
        "../recipesHttp.js"
      );
      vi.mocked(loadRecipePrompt).mockReturnValue(null as never);
      vi.mocked(findYamlRecipePath).mockReturnValue(ymlPath as never);

      const fireStub = vi.fn().mockResolvedValue({ ok: true, taskId: "y2" });
      const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
      const mockOrchestrator = { enqueue: vi.fn(), runAndWait: vi.fn() };

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

      const result = await (server.runRecipeFn as any)("bar");
      expect(result).toEqual({
        ok: false,
        error: "missing_required_vars:issueId",
      });
      expect(fireStub).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('L5: runRecipeFn — required:"false" (string) must not block execution', async () => {
    // Bug: `!required` check treated the string "false" as truthy → vars
    // with required:"false" were incorrectly treated as mandatory.
    const tmpDir = mkdtempSync(join(tmpdir(), "ro-test-"));
    const ymlPath = join(tmpDir, "opt.yaml");
    writeFileSync(
      ymlPath,
      'trigger:\n  inputs:\n    - name: optVar\n      required: "false"\nsteps: []\n',
    );
    try {
      const { loadRecipePrompt, findYamlRecipePath } = await import(
        "../recipesHttp.js"
      );
      vi.mocked(loadRecipePrompt).mockReturnValue(null as never);
      vi.mocked(findYamlRecipePath).mockReturnValue(ymlPath as never);

      const fireStub = vi.fn().mockResolvedValue({ ok: true, taskId: "y99" });
      const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
      const mockOrchestrator = { enqueue: vi.fn(), runAndWait: vi.fn() };

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

      // No vars provided — should not be rejected (optVar has required:"false")
      const result = await (server.runRecipeFn as any)("opt");
      expect(result).not.toMatchObject({
        error: expect.stringContaining("missing_required"),
      });
      expect(fireStub).toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("M3: runRecipeFn — YAML recipe in cfg.recipes.disabled returns recipe_disabled error", async () => {
    const { loadConfig } = await import("../patchworkConfig.js");
    vi.mocked(loadConfig).mockReturnValue({
      recipes: { disabled: ["secret-recipe"] },
    } as never);

    const { loadRecipePrompt, findYamlRecipePath } = await import(
      "../recipesHttp.js"
    );
    vi.mocked(loadRecipePrompt).mockReturnValue(null as never);
    vi.mocked(findYamlRecipePath).mockReturnValue(
      "/r/secret-recipe.yaml" as never,
    );

    const fireStub = vi.fn().mockResolvedValue({ ok: true });
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
    const mockOrchestrator = { enqueue: vi.fn(), runAndWait: vi.fn() };
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

    const result = await (server.runRecipeFn as any)("secret-recipe");
    expect(result).toMatchObject({ ok: false, error: "recipe_disabled" });
    expect(fireStub).not.toHaveBeenCalled();

    // Restore mock to empty config for other tests
    vi.mocked(loadConfig).mockReturnValue({} as never);
  });

  it("M3: webhookFn — recipe in cfg.recipes.disabled is not fired", async () => {
    const { loadConfig } = await import("../patchworkConfig.js");
    vi.mocked(loadConfig).mockReturnValue({
      recipes: { disabled: ["hooked"] },
    } as never);

    const { findWebhookRecipe } = await import("../recipesHttp.js");
    vi.mocked(findWebhookRecipe).mockReturnValue({
      name: "hooked",
      path: "/hooks/hooked",
      filePath: "/r/hooked.yaml",
      format: "yaml",
    } as never);

    const fireStub = vi.fn().mockResolvedValue({ ok: true });
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
    const mockOrchestrator = { enqueue: vi.fn(), runAndWait: vi.fn() };
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

    const result = await (server.webhookFn as any)("/hooks/hooked", {});
    expect(result).toMatchObject({ ok: false, error: "recipe_disabled" });
    expect(fireStub).not.toHaveBeenCalled();

    vi.mocked(loadConfig).mockReturnValue({} as never);
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

  it("fireYamlRecipe() — deliveryId threads manualRunId + a fixed ledgerDir into the dispatch deps (webhook redelivery dedup)", async () => {
    const { dispatchRecipe } = await import("../recipes/yamlRunner.js");
    vi.mocked(dispatchRecipe).mockClear();

    // Capture the dispatchFn passed to recipeOrchestrator.fire() and invoke
    // it ourselves — fire() itself is mocked and would never call it.
    let capturedDispatchFn:
      | ((recipe: unknown, deps: unknown, seedContext: unknown) => unknown)
      | undefined;
    const fireStub = vi.fn().mockImplementation(async (opts) => {
      capturedDispatchFn = opts.dispatchFn;
      return { ok: true, taskId: "t1", name: "foo" };
    });
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
    const mockOrchestrator = { runAndWait: vi.fn() };

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => mockOrchestrator,
      recipeOrchestrator: recipeOrch,
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await ro.fireYamlRecipe({
      filePath: "/r/foo.yaml",
      name: "foo",
      taskIdPrefix: "yaml-webhook-foo",
      triggerSourceSuffix: "webhook:foo",
      logLabel: 'webhook "foo"',
      deliveryId: "deadbeefdeadbeefdeadbeefdeadbeef",
    });

    expect(capturedDispatchFn).toBeDefined();
    await capturedDispatchFn?.({ name: "foo" }, {}, {});

    expect(dispatchRecipe).toHaveBeenCalledTimes(1);
    const passedDeps = vi.mocked(dispatchRecipe).mock.calls[0]![1] as {
      manualRunId?: string;
      ledgerDir?: string;
    };
    expect(passedDeps.manualRunId).toBe("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(passedDeps.ledgerDir).toMatch(
      /[/\\]\.patchwork[/\\]webhook-effect-ledger$/,
    );
  });

  it("fireYamlRecipe() — omits manualRunId/ledgerDir when no deliveryId is given (scheduler/dashboard-fired runs)", async () => {
    const { dispatchRecipe } = await import("../recipes/yamlRunner.js");
    vi.mocked(dispatchRecipe).mockClear();

    let capturedDispatchFn:
      | ((recipe: unknown, deps: unknown, seedContext: unknown) => unknown)
      | undefined;
    const fireStub = vi.fn().mockImplementation(async (opts) => {
      capturedDispatchFn = opts.dispatchFn;
      return { ok: true, taskId: "t1", name: "foo" };
    });
    const recipeOrch = makeRecipeOrchestrator({ fire: fireStub });
    const mockOrchestrator = { runAndWait: vi.fn() };

    const server = makeServer();
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => mockOrchestrator,
      recipeOrchestrator: recipeOrch,
      recipeRunLog: null,
      workdir: "/tmp/ws",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await ro.fireYamlRecipe({
      filePath: "/r/foo.yaml",
      name: "foo",
      taskIdPrefix: "yaml-recipe-foo",
      triggerSourceSuffix: "recipe:foo",
      logLabel: '"foo"',
      // no deliveryId — scheduler/dashboard-fired run
    });

    await capturedDispatchFn?.({ name: "foo" }, {}, {});

    const passedDeps = vi.mocked(dispatchRecipe).mock.calls[0]![1] as {
      manualRunId?: string;
      ledgerDir?: string;
    };
    expect(passedDeps.manualRunId).toBeUndefined();
    expect(passedDeps.ledgerDir).toBeUndefined();
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

describe("resolveWorkerIdForRecipe", () => {
  let workersDir: string;

  beforeEach(() => {
    workersDir = mkdtempSync(join(tmpdir(), "resolve-worker-id-"));
  });

  function writeWorker(fileBase: string, id: string, recipe: string): void {
    writeFileSync(
      join(workersDir, `${fileBase}.worker.yaml`),
      `id: ${id}\nname: ${id}\nrecipe: ${recipe}\n`,
    );
  }

  it("resolves the sole worker whose recipe field matches", async () => {
    writeWorker("a", "triage-bot", "triage-failing-tests");
    const { resolveWorkerIdForRecipe } = RecipeOrchestrationModule;
    const id = await resolveWorkerIdForRecipe(
      "triage-failing-tests",
      workersDir,
    );
    expect(id).toBe("triage-bot");
  });

  it("returns undefined when no worker owns the recipe", async () => {
    writeWorker("a", "triage-bot", "some-other-recipe");
    const { resolveWorkerIdForRecipe } = RecipeOrchestrationModule;
    const id = await resolveWorkerIdForRecipe(
      "triage-failing-tests",
      workersDir,
    );
    expect(id).toBeUndefined();
  });

  it("REGRESSION: returns undefined (never guesses) when TWO workers declare the same recipe", async () => {
    // Bug found in session-review: Array.find picked whichever worker
    // sorted first (loadWorkersFromDir sorts by id) with no validation —
    // silently applying the WRONG worker's patchwork.policy.yml
    // allowedTools list. Ambiguous ownership must resolve to undefined,
    // not a guess.
    writeWorker("a", "worker-alpha", "shared-recipe");
    writeWorker("b", "worker-beta", "shared-recipe");
    const { resolveWorkerIdForRecipe } = RecipeOrchestrationModule;
    const id = await resolveWorkerIdForRecipe("shared-recipe", workersDir);
    expect(id).toBeUndefined();
  });
});
