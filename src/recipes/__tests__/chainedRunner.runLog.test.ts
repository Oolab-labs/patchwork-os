/**
 * Bug fix test: chained recipes must write to RecipeRunLog so the dashboard
 * Runs page shows them. yamlRunner does this; chainedRunner did not — chained
 * runs were invisible to the dashboard.
 *
 * Per Bug Fix Protocol: this test must fail against the buggy version, pass
 * after the fix.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "chained-runlog-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const okDeps: ExecutionDeps = {
  executeTool: vi.fn().mockResolvedValue("ok"),
  executeAgent: vi.fn().mockResolvedValue("agent"),
  loadNestedRecipe: vi.fn().mockResolvedValue(null),
};

function chainedRecipe(): ChainedRecipe & { trigger: { type: string } } {
  return {
    name: "test-chained",
    trigger: { type: "chained" },
    steps: [{ id: "s1", tool: "noop.tool" }],
  };
}

function optsWithLog(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    env: {},
    maxConcurrency: 4,
    maxDepth: 3,
    dryRun: false,
    runLogDir: tmpDir,
    ...overrides,
  } as RunOptions;
}

function readRunLog(): Array<Record<string, unknown>> {
  const file = path.join(tmpDir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("runChainedRecipe — RecipeRunLog write (bug fix)", () => {
  it("writes a successful run to runs.jsonl when runLogDir is set", async () => {
    const result = await runChainedRecipe(
      chainedRecipe(),
      optsWithLog(),
      okDeps,
    );
    expect(result.success).toBe(true);

    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.recipeName).toBe("test-chained");
    expect(r.status).toBe("done");
    expect(r.trigger).toBe("recipe");
    expect(Array.isArray(r.stepResults)).toBe(true);
    expect((r.stepResults as unknown[]).length).toBeGreaterThan(0);
  });

  it("writes a failed run with errorMessage when a step fails", async () => {
    const failingDeps: ExecutionDeps = {
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const result = await runChainedRecipe(
      chainedRecipe(),
      optsWithLog(),
      failingDeps,
    );
    expect(result.success).toBe(false);

    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(typeof runs[0]!.errorMessage).toBe("string");
  });

  it("does not write to run log when runLogDir is omitted (test mode behavior)", async () => {
    const opts: RunOptions = {
      env: {},
      maxConcurrency: 4,
      maxDepth: 3,
      dryRun: false,
    };
    await runChainedRecipe(chainedRecipe(), opts, okDeps);
    expect(readRunLog()).toHaveLength(0);
  });

  it("does not write log entries for nested recipe calls (depth > 0)", async () => {
    // Nested recipe: top-level step calls another recipe. Only the top-level
    // run should produce a log entry; the nested call must not double-log.
    const nestedRecipe: ChainedRecipe = {
      name: "nested",
      trigger: { type: "chained" } as never,
      steps: [{ id: "inner", tool: "noop.tool" }],
    };
    const depsWithNested: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(nestedRecipe),
    };
    const outer: ChainedRecipe & { trigger: { type: string } } = {
      name: "outer",
      trigger: { type: "chained" },
      steps: [{ id: "call-nested", recipe: "nested" }],
    };
    await runChainedRecipe(outer, optsWithLog(), depsWithNested);
    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.recipeName).toBe("outer");
  });
});

// ── VD-1 foundation: bridge-singleton runLog path ──────────────────────────
// When the caller passes a long-lived `runLog`, the runner uses
// startRun/completeRun so the dashboard sees the recipe as `running`
// while it's in flight. Verifies the wiring through the `runLog` option.

describe("runChainedRecipe — runLog (singleton) path", () => {
  it("opens a 'running' entry on start and finalizes to 'done' on success", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const log = new RecipeRunLog({ dir: tmpDir });

    let observedDuringRun: { status: string; seq: number } | null = null;
    const slowDeps: ExecutionDeps = {
      executeTool: vi.fn().mockImplementation(async () => {
        // Snapshot the run state mid-execution: should be `running`.
        const all = log.query();
        if (all[0])
          observedDuringRun = { status: all[0].status, seq: all[0].seq };
        return "ok";
      }),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };

    const result = await runChainedRecipe(
      chainedRecipe(),
      optsWithLog({ runLog: log, runLogDir: undefined }),
      slowDeps,
    );
    expect(result.success).toBe(true);
    expect(observedDuringRun).not.toBeNull();
    expect(observedDuringRun!.status).toBe("running");

    // Final state: same seq, terminal status.
    const finalRun = log.getBySeq(observedDuringRun!.seq);
    expect(finalRun?.status).toBe("done");
    expect((finalRun?.stepResults ?? []).length).toBeGreaterThan(0);
    // Disk persists exactly one row (the completed one — running entries
    // don't hit disk).
    expect(readRunLog()).toHaveLength(1);
  });

  it("finalizes to 'error' status when a step fails", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const log = new RecipeRunLog({ dir: tmpDir });
    const failingDeps: ExecutionDeps = {
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const result = await runChainedRecipe(
      chainedRecipe(),
      optsWithLog({ runLog: log, runLogDir: undefined }),
      failingDeps,
    );
    expect(result.success).toBe(false);
    const runs = log.query();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
  });

  it("runLog option takes precedence over runLogDir (no double-write)", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const log = new RecipeRunLog({ dir: tmpDir });
    await runChainedRecipe(
      chainedRecipe(),
      optsWithLog({ runLog: log }),
      okDeps,
    );
    // Singleton has 1 run; disk file (written via completeRun) has 1 row.
    expect(log.query()).toHaveLength(1);
    expect(readRunLog()).toHaveLength(1);
  });
});
