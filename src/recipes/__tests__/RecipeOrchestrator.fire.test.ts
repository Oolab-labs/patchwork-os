/**
 * RED parity tests for RecipeOrchestrator.fire() — method does not exist yet.
 * All tests expected to fail (TypeError or similar) until fire() is implemented.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("isInFlight(name) returns false after dispatch rejects (no unhandled rejection)", async () => {
    const recipe = makeYamlRecipe("reject-recipe");
    const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
    const { promise, reject } = deferred<RunResult>();
    const dispatchFn = vi.fn().mockReturnValue(promise);

    const orchestrator = new RecipeOrchestrator(baseDeps(), {
      loadYamlRecipe,
      dispatchFn,
    });
    await orchestrator.fire({
      filePath: "/recipes/reject-recipe.yaml",
      name: "reject-recipe",
      triggerSource: "test",
    });

    expect(orchestrator.isInFlight("reject-recipe")).toBe(true);

    reject(new Error("dispatch failed"));
    // Flush microtasks so .finally() handler runs
    await new Promise((r) => setImmediate(r));

    expect(orchestrator.isInFlight("reject-recipe")).toBe(false);
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

  describe("merges declared trigger.vars/inputs defaults into seedContext (Bug 1)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "fire-vardefaults-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("fills a declared repo default the caller didn't supply, event vars still win", async () => {
      // Mirrors the on_test_run path: the trigger seeds only event placeholders
      // ({{runner}}, {{failed}}), never the recipe's declared `repo` default.
      // Pre-fix, dispatch got that raw seedContext and github.create_issue
      // hard-errored on empty repo.
      const ymlPath = path.join(dir, "triage.yaml");
      writeFileSync(
        ymlPath,
        [
          "name: triage",
          "trigger:",
          "  type: on_test_run",
          "  vars:",
          "    - name: repo",
          '      default: "owner/repo"',
          "steps:",
          "  - tool: file.write",
          "    path: /tmp/x",
          "    content: hi",
        ].join("\n"),
      );
      const recipe = makeYamlRecipe("triage");
      const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
      const { promise, resolve } = deferred<RunResult>();
      const dispatchFn = vi.fn().mockReturnValue(promise);

      const orchestrator = new RecipeOrchestrator(baseDeps(), {
        loadYamlRecipe,
        dispatchFn,
      });
      await orchestrator.fire({
        filePath: ymlPath,
        name: "triage",
        triggerSource: "automation:on_test_run",
        seedContext: { runner: "vitest", failed: "1" },
      });
      resolve(makeRunResult());

      const passedContext = dispatchFn.mock.calls[0]?.[2] as Record<
        string,
        string
      >;
      // declared default filled…
      expect(passedContext.repo).toBe("owner/repo");
      // …and event vars preserved (caller wins on overlap).
      expect(passedContext.runner).toBe("vitest");
      expect(passedContext.failed).toBe("1");
    });

    it("caller value overrides a declared default (no clobber)", async () => {
      const ymlPath = path.join(dir, "triage.yaml");
      writeFileSync(
        ymlPath,
        [
          "name: triage",
          "trigger:",
          "  type: on_test_run",
          "  vars:",
          "    - name: repo",
          '      default: "owner/default-repo"',
          "steps:",
          "  - tool: file.write",
          "    path: /tmp/x",
          "    content: hi",
        ].join("\n"),
      );
      const loadYamlRecipe = vi.fn().mockReturnValue(makeYamlRecipe("triage"));
      const { promise, resolve } = deferred<RunResult>();
      const dispatchFn = vi.fn().mockReturnValue(promise);

      const orchestrator = new RecipeOrchestrator(baseDeps(), {
        loadYamlRecipe,
        dispatchFn,
      });
      await orchestrator.fire({
        filePath: ymlPath,
        name: "triage",
        triggerSource: "test",
        seedContext: { repo: "owner/explicit" },
      });
      resolve(makeRunResult());

      const passedContext = dispatchFn.mock.calls[0]?.[2] as Record<
        string,
        string
      >;
      expect(passedContext.repo).toBe("owner/explicit");
    });
  });

  it("frees the in-flight slot after dispatchTimeoutMs when dispatch never settles (audit 2026-06-09 orch-hang-1)", async () => {
    vi.useFakeTimers();
    try {
      const recipe = makeYamlRecipe("hang-recipe");
      const loadYamlRecipe = vi.fn().mockReturnValue(recipe);
      // Dispatch promise that NEVER settles — simulates a hung tool step.
      const dispatchFn = vi
        .fn()
        .mockReturnValue(new Promise<RunResult>(() => {}));

      const orchestrator = new RecipeOrchestrator(baseDeps(), {
        loadYamlRecipe,
        dispatchFn,
        dispatchTimeoutMs: 1000,
      });

      const first = await orchestrator.fire({
        filePath: "/recipes/hang-recipe.yaml",
        name: "hang-recipe",
        triggerSource: "test",
      });
      expect(first).toMatchObject({ ok: true });
      expect(orchestrator.isInFlight("hang-recipe")).toBe(true);

      // Before the TTL elapses, a second fire is still rejected.
      const blocked = await orchestrator.fire({
        filePath: "/recipes/hang-recipe.yaml",
        name: "hang-recipe",
        triggerSource: "test",
      });
      expect(blocked).toMatchObject({ ok: false, error: "already_in_flight" });

      // After the TTL, the safety net frees the slot.
      vi.advanceTimersByTime(1000);
      expect(orchestrator.isInFlight("hang-recipe")).toBe(false);

      const retried = await orchestrator.fire({
        filePath: "/recipes/hang-recipe.yaml",
        name: "hang-recipe",
        triggerSource: "test",
      });
      expect(retried).toMatchObject({ ok: true });
      expect(dispatchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
