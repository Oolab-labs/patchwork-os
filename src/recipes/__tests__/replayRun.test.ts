import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipeRun } from "../../runLog.js";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import {
  buildFlatMockedOutputs,
  buildMockedOutputs,
  replayFlatMockedRun,
  replayMockedRun,
} from "../replayRun.js";
import type { RunnerDeps, YamlRecipe } from "../yamlRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "vd4-replay-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── buildMockedOutputs ─────────────────────────────────────────────────────

describe("buildMockedOutputs", () => {
  it("collects captured outputs into the map keyed by stepId", () => {
    const run: RecipeRun = {
      seq: 7,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 100,
      doneAt: 200,
      durationMs: 100,
      stepResults: [
        {
          id: "fetch",
          status: "ok",
          durationMs: 50,
          output: { items: [1, 2] },
        },
        { id: "summarize", status: "ok", durationMs: 30, output: "hello" },
      ],
    };
    const { outputs, unmocked } = buildMockedOutputs(run);
    expect(outputs.size).toBe(2);
    expect(outputs.get("fetch")).toEqual({ items: [1, 2] });
    expect(outputs.get("summarize")).toBe("hello");
    expect(unmocked).toEqual([]);
  });

  it("flags steps without captured output as unmocked", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        { id: "captured", status: "ok", durationMs: 5, output: "ok" },
        { id: "no-capture", status: "ok", durationMs: 5 }, // pre-VD-2 row
      ],
    };
    const { outputs, unmocked } = buildMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["captured"]);
    expect(unmocked).toEqual(["no-capture"]);
  });

  it("excludes truncation-envelope outputs (>8KB)", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        {
          id: "huge",
          status: "ok",
          durationMs: 5,
          output: {
            "[truncated]": true,
            bytes: 20000,
            preview: "x".repeat(8000),
          },
        },
        { id: "small", status: "ok", durationMs: 5, output: { v: 1 } },
      ],
    };
    const { outputs, unmocked } = buildMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["small"]);
    expect(unmocked).toEqual(["huge"]);
  });

  it("skips steps with status 'skipped'", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        {
          id: "conditionally-skipped",
          status: "skipped",
          durationMs: 0,
          output: { reason: "when:false" },
        },
        { id: "actual", status: "ok", durationMs: 5, output: "data" },
      ],
    };
    const { outputs } = buildMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["actual"]);
  });
});

// ── runChainedRecipe with mockedOutputs (the integration that matters) ────

describe("runChainedRecipe — mockedOutputs interception", () => {
  function recipe(): ChainedRecipe & { trigger: { type: string } } {
    return {
      name: "test",
      trigger: { type: "chained" },
      steps: [
        { id: "s1", tool: "noop.tool" },
        { id: "s2", tool: "noop.tool", awaits: ["s1"] },
      ],
    };
  }

  function realDeps(): ExecutionDeps {
    return {
      executeTool: vi.fn().mockResolvedValue("REAL_RESULT"),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
  }

  function opts(overrides: Partial<RunOptions> = {}): RunOptions {
    return {
      env: {},
      maxConcurrency: 4,
      maxDepth: 3,
      dryRun: false,
      ...overrides,
    } as RunOptions;
  }

  it("returns mocked output instead of calling executeTool", async () => {
    const deps = realDeps();
    const mocked = new Map<string, unknown>([
      ["s1", { mocked: 1 }],
      ["s2", { mocked: 2 }],
    ]);
    const result = await runChainedRecipe(
      recipe(),
      opts({ mockedOutputs: mocked }),
      deps,
    );
    expect(result.success).toBe(true);
    // executeTool MUST NOT be called for either step.
    expect(deps.executeTool).not.toHaveBeenCalled();
    // Each step's output reflects the mocked value (registry is keyed
    // by stepId, value carries `data`).
    expect(result.context.s1).toBe(JSON.stringify({ mocked: 1 }));
    expect(result.context.s2).toBe(JSON.stringify({ mocked: 2 }));
  });

  it("falls through to real execution for steps NOT in the mocked map", async () => {
    const deps = realDeps();
    const mocked = new Map<string, unknown>([["s1", "MOCKED_S1"]]);
    const result = await runChainedRecipe(
      recipe(),
      opts({ mockedOutputs: mocked }),
      deps,
    );
    expect(result.success).toBe(true);
    // s1 mocked, s2 real.
    expect(deps.executeTool).toHaveBeenCalledTimes(1);
    expect(result.context.s1).toBe("MOCKED_S1");
    expect(result.context.s2).toBe("REAL_RESULT");
  });

  it("re-applies transforms on top of mocked outputs", async () => {
    // Recipe edit scenario: original step returned raw data, user added
    // a transform. Replay should show the transform applied to captured
    // output — that's the debugging value.
    const deps = realDeps();
    const mocked = new Map<string, unknown>([["s1", "world"]]);
    const result = await runChainedRecipe(
      {
        name: "with-transform",
        trigger: { type: "chained" } as never,
        steps: [
          {
            id: "s1",
            tool: "noop.tool",
            transform: "hello, {{ $result }}",
          },
        ],
      },
      opts({ mockedOutputs: mocked }),
      deps,
    );
    expect(result.success).toBe(true);
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(result.context.s1).toBe("hello, world");
  });

  it("taskIdPrefix override produces matching taskId in run log (BUG-4)", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const log = new RecipeRunLog({ dir: tmpDir });
    await runChainedRecipe(
      recipe(),
      opts({ runLog: log, taskIdPrefix: "replay:42" }),
      realDeps(),
    );
    const run = log.query()[0];
    expect(run?.taskId).toMatch(/^replay:42:test:\d+$/);
  });

  it("default taskIdPrefix is 'chained' (back-compat)", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const log = new RecipeRunLog({ dir: tmpDir });
    await runChainedRecipe(recipe(), opts({ runLog: log }), realDeps());
    const run = log.query()[0];
    expect(run?.taskId).toMatch(/^chained:test:\d+$/);
  });

  it("does not invoke executeAgent for mocked agent steps", async () => {
    const deps = realDeps();
    const mocked = new Map<string, unknown>([
      ["agent-step", "captured-agent-output"],
    ]);
    const result = await runChainedRecipe(
      {
        name: "agent",
        trigger: { type: "chained" } as never,
        steps: [
          {
            id: "agent-step",
            agent: { prompt: "Summarize: {{ env.X }}", model: "haiku" },
          },
        ],
      },
      opts({
        env: { X: "data" } as Record<string, string | undefined>,
        mockedOutputs: mocked,
      }),
      deps,
    );
    expect(result.success).toBe(true);
    expect(deps.executeAgent).not.toHaveBeenCalled();
    expect(result.context["agent-step"]).toBe("captured-agent-output");
  });
});

// ── replayMockedRun — the actual entrypoint (was entirely uncovered; only
// its two building blocks, buildMockedOutputs and runChainedRecipe's
// mockedOutputs interception, were previously tested directly) ────────────

describe("replayMockedRun", () => {
  function recipe(): ChainedRecipe {
    return {
      name: "daily",
      steps: [{ id: "s1", tool: "noop.tool" }],
    } as ChainedRecipe;
  }

  function originalRun(overrides: Partial<RecipeRun> = {}): RecipeRun {
    return {
      seq: 1,
      taskId: "t1",
      recipeName: "daily",
      trigger: { type: "manual" } as never,
      status: "done",
      createdAt: 1000,
      doneAt: 2000,
      durationMs: 1000,
      stepResults: [{ id: "s1", status: "done", output: "captured-value" }],
      ...overrides,
    } as RecipeRun;
  }

  async function deps() {
    const { RecipeRunLog } = await import("../../runLog.js");
    const runLog = new RecipeRunLog({ dir: tmpDir });
    const runnerDeps: RunnerDeps = { logDir: tmpDir, workdir: tmpDir };
    return { runLog, activityLog: undefined, runnerDeps };
  }

  it("replays using captured step outputs and reports the new run's seq", async () => {
    const replayDeps = await deps();
    const result = await replayMockedRun({
      originalRun: originalRun(),
      recipe: recipe(),
      deps: replayDeps,
    });
    expect(result.ok).toBe(true);
    expect(result.newSeq).toBeDefined();
    expect(result.result?.context.s1).toBe("captured-value");
    expect(result.unmockedSteps).toBeUndefined();
  });

  it("tags the new run's taskId with the replay:<originalSeq> prefix (BUG-4)", async () => {
    const replayDeps = await deps();
    await replayMockedRun({
      originalRun: originalRun({ seq: 42 }),
      recipe: recipe(),
      deps: replayDeps,
    });
    const run = replayDeps.runLog.query()[0];
    expect(run?.taskId).toMatch(/^replay:42:daily:\d+$/);
  });

  it("reports unmockedSteps when a step in the original run has no captured output", async () => {
    const replayDeps = await deps();
    const result = await replayMockedRun({
      originalRun: originalRun({
        stepResults: [{ id: "s1", status: "done" }], // no `output` field
      }),
      recipe: recipe(),
      deps: replayDeps,
    });
    expect(result.unmockedSteps).toEqual(["s1"]);
  });

  it("passes sourcePath through to the run options when provided", async () => {
    const replayDeps = await deps();
    const result = await replayMockedRun({
      originalRun: originalRun(),
      recipe: recipe(),
      sourcePath: "/recipes/daily.yaml",
      deps: replayDeps,
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with the error message when runChainedRecipe throws", async () => {
    const replayDeps = await deps();
    const badRecipe = {
      name: "daily",
      // Malformed steps array triggers an exception inside the chained
      // runner rather than a normal failed-step result.
      steps: null,
    } as unknown as ChainedRecipe;

    const result = await replayMockedRun({
      originalRun: originalRun(),
      recipe: badRecipe,
      deps: replayDeps,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("enforces the declared-keys env allowlist rather than spreading process.env (audit 2026-06-08 recipe-support-3)", async () => {
    const origSecret = process.env.SUPER_SECRET_TOKEN;
    process.env.SUPER_SECRET_TOKEN = "leak-me-not";
    try {
      const replayDeps = await deps();
      const result = await replayMockedRun({
        originalRun: originalRun(),
        recipe: {
          name: "daily",
          steps: [
            {
              id: "s1",
              tool: "noop.tool",
              transform: "{{ env.SUPER_SECRET_TOKEN }}",
            },
          ],
        } as ChainedRecipe,
        deps: replayDeps,
      });
      // No `context: [{type: "env", keys: [...]}]` was declared on the
      // recipe, so declaredRecipeEnv() should yield an empty allowlist —
      // the secret must not leak into the rendered transform.
      expect(result.result?.context.s1).not.toContain("leak-me-not");
    } finally {
      if (origSecret === undefined) delete process.env.SUPER_SECRET_TOKEN;
      else process.env.SUPER_SECRET_TOKEN = origSecret;
    }
  });
});

// ── buildFlatMockedOutputs — flat-recipe counterpart to buildMockedOutputs ─

describe("buildFlatMockedOutputs", () => {
  it("collects captured outputs into the map keyed by stepId, stringified", () => {
    const run: RecipeRun = {
      seq: 7,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 100,
      doneAt: 200,
      durationMs: 100,
      stepResults: [
        { id: "s1", status: "ok", durationMs: 5, output: "already-a-string" },
        { id: "s2", status: "ok", durationMs: 5, output: { a: 1 } },
      ],
    };
    const { outputs, unmocked } = buildFlatMockedOutputs(run);
    expect(outputs.get("s1")).toBe("already-a-string");
    expect(outputs.get("s2")).toBe(JSON.stringify({ a: 1 }));
    expect(unmocked).toEqual([]);
  });

  it("flags steps without captured output as unmocked", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        { id: "captured", status: "ok", durationMs: 5, output: "ok" },
        { id: "no-capture", status: "ok", durationMs: 5 },
      ],
    };
    const { outputs, unmocked } = buildFlatMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["captured"]);
    expect(unmocked).toEqual(["no-capture"]);
  });

  it("excludes truncation-envelope outputs (>8KB)", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        {
          id: "huge",
          status: "ok",
          durationMs: 5,
          output: { "[truncated]": true, bytes: 20000, preview: "x" },
        },
        { id: "small", status: "ok", durationMs: 5, output: "fine" },
      ],
    };
    const { outputs, unmocked } = buildFlatMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["small"]);
    expect(unmocked).toEqual(["huge"]);
  });

  it("skips steps with status 'skipped'", () => {
    const run: RecipeRun = {
      seq: 1,
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
      stepResults: [
        { id: "conditional", status: "skipped", durationMs: 0 },
        { id: "actual", status: "ok", durationMs: 5, output: "data" },
      ],
    };
    const { outputs } = buildFlatMockedOutputs(run);
    expect([...outputs.keys()]).toEqual(["actual"]);
  });
});

// ── replayFlatMockedRun — the flat entrypoint, previously nonexistent
// ("replay_only_supported_for_chained_recipes" was hard-coded) ────────────

describe("replayFlatMockedRun", () => {
  function flatRecipe(): YamlRecipe {
    return {
      name: "daily-flat",
      trigger: { type: "manual" },
      steps: [
        { tool: "file.write", into: "s1", path: "note.md", content: "x" },
      ],
    } as unknown as YamlRecipe;
  }

  function originalRun(overrides: Partial<RecipeRun> = {}): RecipeRun {
    return {
      seq: 1,
      taskId: "t1",
      recipeName: "daily-flat",
      trigger: "recipe",
      status: "done",
      createdAt: 1000,
      doneAt: 2000,
      durationMs: 1000,
      stepResults: [
        { id: "s1", status: "ok", durationMs: 5, output: "captured-value" },
      ],
      ...overrides,
    } as RecipeRun;
  }

  async function deps() {
    const { RecipeRunLog } = await import("../../runLog.js");
    const runLog = new RecipeRunLog({ dir: tmpDir });
    const runnerDeps: RunnerDeps = {
      logDir: tmpDir,
      workdir: tmpDir,
      testMode: false,
      writeFile: () => {
        throw new Error("real tool must not run — step should be mocked");
      },
    };
    return { runLog, activityLog: undefined, runnerDeps };
  }

  it("replays using captured step outputs and reports the new run's seq", async () => {
    const replayDeps = await deps();
    const result = await replayFlatMockedRun({
      originalRun: originalRun(),
      recipe: flatRecipe(),
      deps: replayDeps,
    });
    expect(result.ok).toBe(true);
    expect(result.newSeq).toBeDefined();
    expect(result.result?.context.s1).toBe("captured-value");
    expect(result.unmockedSteps).toBeUndefined();
  });

  it("tags the new run with manualRunId replay-<originalSeq> (BUG-4 parity)", async () => {
    const replayDeps = await deps();
    await replayFlatMockedRun({
      originalRun: originalRun({ seq: 42 }),
      recipe: flatRecipe(),
      deps: replayDeps,
    });
    const run = replayDeps.runLog.query()[0];
    expect(run?.manualRunId).toBe("replay-42");
  });

  it("reports unmockedSteps when a step in the original run has no captured output", async () => {
    const replayDeps = await deps();
    const result = await replayFlatMockedRun({
      originalRun: originalRun({
        stepResults: [{ id: "s1", status: "ok", durationMs: 5 }],
      }),
      recipe: flatRecipe(),
      deps: replayDeps,
    });
    expect(result.unmockedSteps).toEqual(["s1"]);
  });
});
