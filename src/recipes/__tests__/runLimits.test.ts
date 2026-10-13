/**
 * Operator run limit — PATCHWORK_MAX_CONCURRENT_RUNS.
 *
 * The variable used to be accepted and read by nothing, so setting it changed
 * nothing. Every workflow entry path (manual, dashboard, cron, webhook,
 * automation hook) reaches the runtime through `RecipeOrchestrator.fire()`,
 * so that is where the limit is counted. Nested child recipes execute inside
 * their parent's dispatch and never pass through `fire()`, so they belong to
 * the parent's run and must not consume a slot of their own.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ChainedRecipe,
  type ExecutionDeps,
  runChainedRecipe,
} from "../chainedRunner.js";
import { RecipeOrchestrator } from "../RecipeOrchestrator.js";
import {
  maxConcurrentRunsFromEnv,
  parseOperatorLimit,
  RUN_LIMIT_REACHED,
  runLimitMessage,
} from "../runLimits.js";
import type { RunResult, YamlRecipe } from "../yamlRunner.js";

function recipe(name: string): YamlRecipe {
  return { name, trigger: { type: "manual" }, steps: [] } as YamlRecipe;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const done = { stepsRun: 0, outputs: {}, context: {} } as unknown as RunResult;
const tick = () => new Promise((r) => setImmediate(r));

function makeOrchestrator(
  maxConcurrentRuns: number | null | undefined,
  dispatchFn: (r: YamlRecipe) => Promise<RunResult>,
  extra: { dispatchTimeoutMs?: number } = {},
) {
  return new RecipeOrchestrator({} as never, {
    loadYamlRecipe: (p: string) => recipe(p.replace(/^\/r\/|\.yaml$/g, "")),
    dispatchFn: (r) => dispatchFn(r),
    ...(maxConcurrentRuns !== undefined && { maxConcurrentRuns }),
    ...extra,
  });
}

const fireReq = (name: string) => ({
  filePath: `/r/${name}.yaml`,
  name,
  triggerSource: `recipe:${name}`,
});

describe("parseOperatorLimit", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["0", null],
    ["-3", null],
    ["abc", null],
    ["2.5", null],
    ["  ", null],
    ["1", 1],
    ["12", 12],
    [" 4 ", 4],
  ])("%j -> %j", (raw, expected) => {
    expect(parseOperatorLimit(raw)).toBe(expected);
  });

  it("reads PATCHWORK_MAX_CONCURRENT_RUNS", () => {
    expect(
      maxConcurrentRunsFromEnv({ PATCHWORK_MAX_CONCURRENT_RUNS: "3" }),
    ).toBe(3);
    expect(maxConcurrentRunsFromEnv({})).toBeNull();
  });
});

describe("runLimitMessage", () => {
  it("names the limit in plain words", () => {
    expect(runLimitMessage(3)).toBe(
      "3 runs are already in progress; try again when one finishes",
    );
    expect(runLimitMessage(1)).toBe(
      "1 run is already in progress; try again when one finishes",
    );
  });
});

describe("RecipeOrchestrator — concurrent run limit", () => {
  it("with no limit, runs of different recipes all start (unchanged behaviour)", async () => {
    const gate = deferred<RunResult>();
    const orch = makeOrchestrator(undefined, () => gate.promise);
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((n) => orch.fire(fireReq(n))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    gate.resolve(done);
  });

  it("refuses a run beyond the limit before it is dispatched", async () => {
    const gate = deferred<RunResult>();
    const dispatch = vi.fn(() => gate.promise);
    const orch = makeOrchestrator(2, dispatch);

    expect((await orch.fire(fireReq("a"))).ok).toBe(true);
    expect((await orch.fire(fireReq("b"))).ok).toBe(true);
    const refused = await orch.fire(fireReq("c"));

    expect(refused).toEqual({
      ok: false,
      error: RUN_LIMIT_REACHED,
      message: runLimitMessage(2),
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(orch.activeRunCount()).toBe(2);
    gate.resolve(done);
  });

  it("frees the slot when a run finishes", async () => {
    const first = deferred<RunResult>();
    const orch = makeOrchestrator(1, (r) =>
      r.name === "a" ? first.promise : Promise.resolve(done),
    );
    expect((await orch.fire(fireReq("a"))).ok).toBe(true);
    expect((await orch.fire(fireReq("b"))).ok).toBe(false);
    first.resolve(done);
    await tick();
    expect(orch.activeRunCount()).toBe(0);
    expect((await orch.fire(fireReq("b"))).ok).toBe(true);
  });

  it("frees the slot when a run fails", async () => {
    const orch = makeOrchestrator(1, () => Promise.reject(new Error("boom")));
    expect((await orch.fire(fireReq("a"))).ok).toBe(true);
    await tick();
    expect((await orch.fire(fireReq("b"))).ok).toBe(true);
  });

  it("frees the slot when the dispatch safety timer fires", async () => {
    vi.useFakeTimers();
    try {
      const orch = makeOrchestrator(1, () => new Promise<RunResult>(() => {}), {
        dispatchTimeoutMs: 1000,
      });
      expect((await orch.fire(fireReq("a"))).ok).toBe(true);
      expect((await orch.fire(fireReq("b"))).ok).toBe(false);
      vi.advanceTimersByTime(1001);
      expect((await orch.fire(fireReq("b"))).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts runs of the same recipe separately when dedup is allowed", async () => {
    const gate = deferred<RunResult>();
    const orch = makeOrchestrator(1, () => gate.promise);
    expect(
      (await orch.fire({ ...fireReq("a"), dedupPolicy: "allow" })).ok,
    ).toBe(true);
    const second = await orch.fire({ ...fireReq("a"), dedupPolicy: "allow" });
    expect(second).toMatchObject({ ok: false, error: RUN_LIMIT_REACHED });
    gate.resolve(done);
  });

  it("keeps already_in_flight for the same recipe (more specific refusal)", async () => {
    const gate = deferred<RunResult>();
    const orch = makeOrchestrator(1, () => gate.promise);
    await orch.fire(fireReq("a"));
    expect(await orch.fire(fireReq("a"))).toEqual({
      ok: false,
      error: "already_in_flight",
    });
    gate.resolve(done);
  });

  it("reads the limit from PATCHWORK_MAX_CONCURRENT_RUNS by default", async () => {
    vi.stubEnv("PATCHWORK_MAX_CONCURRENT_RUNS", "1");
    try {
      const gate = deferred<RunResult>();
      const orch = new RecipeOrchestrator({} as never, {
        loadYamlRecipe: () => recipe("x"),
        dispatchFn: () => gate.promise,
      });
      expect((await orch.fire(fireReq("a"))).ok).toBe(true);
      expect(await orch.fire(fireReq("b"))).toMatchObject({
        error: RUN_LIMIT_REACHED,
      });
      gate.resolve(done);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not count nested child recipes as extra runs", async () => {
    // Parent `outer` calls child `inner` through a real nested-recipe step.
    // With a limit of 1 the parent occupies the only slot; the child must
    // still run, because it is part of the parent's run.
    const child: ChainedRecipe = {
      name: "inner",
      steps: [{ id: "c", tool: "child.tool" }],
    };
    const parent: ChainedRecipe = {
      name: "outer",
      steps: [{ id: "p", recipe: "inner" }],
    };
    const childStarted = deferred<void>();
    const releaseChild = deferred<unknown>();
    const executeTool = vi.fn(async () => {
      childStarted.resolve();
      return releaseChild.promise;
    });
    const execDeps: ExecutionDeps = {
      executeTool,
      executeAgent: vi.fn().mockResolvedValue("ok"),
      loadNestedRecipe: vi
        .fn()
        .mockResolvedValue({ recipe: child, sourcePath: "/r/inner.yaml" }),
    };
    let parentResult: { success: boolean } | undefined;
    const orch = makeOrchestrator(1, async () => {
      parentResult = (await runChainedRecipe(
        parent,
        {
          env: {},
          maxConcurrency: 1,
          maxDepth: 3,
          dryRun: false,
          sourcePath: "/r/outer.yaml",
        },
        execDeps,
      )) as unknown as { success: boolean };
      return done;
    });

    expect((await orch.fire(fireReq("outer"))).ok).toBe(true);
    await childStarted.promise;
    // Parent + its child are in progress: exactly one run is counted.
    expect(orch.activeRunCount()).toBe(1);
    // Another top-level run is still refused while the parent holds the slot.
    expect(await orch.fire(fireReq("other"))).toMatchObject({
      error: RUN_LIMIT_REACHED,
    });
    releaseChild.resolve("child done");
    await vi.waitFor(() => expect(parentResult?.success).toBe(true));
    expect(executeTool).toHaveBeenCalledTimes(1);
    await tick();
    expect(orch.activeRunCount()).toBe(0);
  });
});
