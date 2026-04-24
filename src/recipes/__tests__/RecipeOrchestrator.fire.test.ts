/**
 * RED parity tests for RecipeOrchestrator.fire() — method does not exist yet.
 * All tests expected to fail (TypeError or similar) until fire() is implemented.
 */

import { describe, expect, it, vi } from "vitest";
import { RecipeOrchestrator } from "../RecipeOrchestrator.js";
import type { RunResult, YamlRecipe } from "../yamlRunner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeYamlRecipe(name = "test-recipe"): YamlRecipe {
  return {
    name,
    trigger: { type: "manual" },
    steps: [{ tool: "file.write", path: "/tmp/x", content: "hi" }],
  };
}

/** Deferred promise — lets tests control when dispatchFn resolves. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRunResult(): RunResult {
  return {
    stepsRun: 1,
    outputs: {},
    context: {},
    errorMessage: undefined,
  } as unknown as RunResult;
}

function baseDeps() {
  return {
    now: () => new Date("2026-04-25T12:00:00Z"),
    logDir: "/tmp/fire-test-logs",
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipeOrchestrator.fire()", () => {
  it("returns { ok: true, taskId, name } on success", async () => {
    const recipe = makeYamlRecipe("my-recipe");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    const result = await orchestrator.fire({
      filePath: "/recipes/my-recipe.yaml",
      name: "my-recipe",
      triggerSource: "test",
    });

    resolve(makeRunResult());

    expect(result).toMatchObject({ ok: true, name: "my-recipe" });
    expect(
      typeof (result as { ok: true; taskId: string; name: string }).taskId,
    ).toBe("string");
    expect(
      (result as { ok: true; taskId: string; name: string }).taskId.length,
    ).toBeGreaterThan(0);
  });

  it("calls loadYamlRecipe with the provided filePath", async () => {
    const recipe = makeYamlRecipe("load-check");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    await orchestrator.fire({
      filePath: "/recipes/load-check.yaml",
      name: "load-check",
      triggerSource: "test",
    });

    resolve(makeRunResult());

    expect(loadYamlRecipe).toHaveBeenCalledWith("/recipes/load-check.yaml");
  });

  it("calls dispatchFn with the loaded recipe (fire-and-forget)", async () => {
    const recipe = makeYamlRecipe("dispatch-check");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });

    // fire() must return before dispatch resolves
    const firePromise = orchestrator.fire({
      filePath: "/recipes/dispatch-check.yaml",
      name: "dispatch-check",
      triggerSource: "ci",
      seedContext: { branch: "main" },
    });

    const result = await firePromise;
    expect(result).toMatchObject({ ok: true });

    // dispatchFn was called (fire-and-forget — not awaited by fire())
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    expect(dispatchFn).toHaveBeenCalledWith(
      recipe,
      expect.any(Object), // RunnerDeps forwarded
      expect.objectContaining({ branch: "main" }),
    );

    resolve(makeRunResult());
  });

  it("returns { ok: false, error } when loadYamlRecipe throws", async () => {
    const loadYamlRecipe = vi.fn().mockImplementation(() => {
      throw new Error("YAML parse error: bad indent");
    });
    const dispatchFn = vi.fn();

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    const result = await orchestrator.fire({
      filePath: "/recipes/bad.yaml",
      name: "bad-recipe",
      triggerSource: "test",
    });

    expect(result).toMatchObject({ ok: false });
    expect(typeof (result as { ok: false; error: string }).error).toBe(
      "string",
    );
    expect(
      (result as { ok: false; error: string }).error.length,
    ).toBeGreaterThan(0);
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("isInFlight(name) returns true after fire() returns (before dispatch resolves)", async () => {
    const recipe = makeYamlRecipe("inflight-check");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    await orchestrator.fire({
      filePath: "/recipes/inflight-check.yaml",
      name: "inflight-check",
      triggerSource: "test",
    });

    // Still in-flight — dispatch promise not yet resolved
    expect(orchestrator.isInFlight("inflight-check")).toBe(true);

    resolve(makeRunResult());
  });

  it("isInFlight(name) returns false after dispatch promise resolves", async () => {
    const recipe = makeYamlRecipe("completed-check");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    await orchestrator.fire({
      filePath: "/recipes/completed-check.yaml",
      name: "completed-check",
      triggerSource: "test",
    });

    expect(orchestrator.isInFlight("completed-check")).toBe(true);

    resolve(makeRunResult());
    // Flush microtasks so the internal .then() handler runs
    await promise;
    await new Promise((r) => setImmediate(r));

    expect(orchestrator.isInFlight("completed-check")).toBe(false);
  });

  it("second fire() for same name while first is in-flight returns { ok: false, error: 'already_in_flight' } (default dedupPolicy)", async () => {
    const recipe = makeYamlRecipe("dedup-recipe");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, resolve } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });

    const first = await orchestrator.fire({
      filePath: "/recipes/dedup-recipe.yaml",
      name: "dedup-recipe",
      triggerSource: "test",
    });
    expect(first).toMatchObject({ ok: true });

    const second = await orchestrator.fire({
      filePath: "/recipes/dedup-recipe.yaml",
      name: "dedup-recipe",
      triggerSource: "test",
    });
    expect(second).toMatchObject({ ok: false, error: "already_in_flight" });

    // dispatchFn called only once (dedup rejected second launch)
    expect(dispatchFn).toHaveBeenCalledTimes(1);

    resolve(makeRunResult());
  });

  it("second fire() with dedupPolicy 'allow' while first is in-flight succeeds (both launched)", async () => {
    const recipe = makeYamlRecipe("allow-recipe");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const d1 = deferred<RunResult>();
    const d2 = deferred<RunResult>();
    const dispatchFn = vi
      .fn()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });

    const first = await orchestrator.fire({
      filePath: "/recipes/allow-recipe.yaml",
      name: "allow-recipe",
      triggerSource: "test",
    });
    expect(first).toMatchObject({ ok: true });

    const second = await orchestrator.fire({
      filePath: "/recipes/allow-recipe.yaml",
      name: "allow-recipe",
      triggerSource: "test",
      dedupPolicy: "allow",
    });
    expect(second).toMatchObject({ ok: true });

    // Both launches proceeded
    expect(dispatchFn).toHaveBeenCalledTimes(2);

    d1.resolve(makeRunResult());
    d2.resolve(makeRunResult());
  });

  it("per-call dispatchFn override is used instead of constructor default", async () => {
    const recipe = makeYamlRecipe("override-recipe");
    const constructorDispatch = vi.fn().mockResolvedValue(makeRunResult());
    const callDispatch = vi.fn().mockResolvedValue(makeRunResult());
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn: constructorDispatch,
    });
    await orchestrator.fire({
      filePath: "/recipes/override-recipe.yaml",
      name: "override-recipe",
      triggerSource: "test",
      dispatchFn: callDispatch,
    });

    expect(callDispatch).toHaveBeenCalledTimes(1);
    expect(constructorDispatch).not.toHaveBeenCalled();
  });

  it("listInFlight() returns all currently running recipe names", async () => {
    const loadYamlRecipe = vi
      .fn()
      .mockImplementation((p: string) =>
        makeYamlRecipe(p.replace(/.*\/|\.yaml/g, "")),
      );
    const d1 = deferred<RunResult>();
    const d2 = deferred<RunResult>();
    const dispatchFn = vi
      .fn()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });

    await orchestrator.fire({
      filePath: "/r/alpha.yaml",
      name: "alpha",
      triggerSource: "t",
    });
    await orchestrator.fire({
      filePath: "/r/beta.yaml",
      name: "beta",
      triggerSource: "t",
    });

    expect(orchestrator.listInFlight().sort()).toEqual(["alpha", "beta"]);

    d1.resolve(makeRunResult());
    await d1.promise;
    await new Promise((r) => setImmediate(r));

    expect(orchestrator.listInFlight()).toEqual(["beta"]);

    d2.resolve(makeRunResult());
  });
});
