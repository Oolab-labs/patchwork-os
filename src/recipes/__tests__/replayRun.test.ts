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
import { buildMockedOutputs } from "../replayRun.js";

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
