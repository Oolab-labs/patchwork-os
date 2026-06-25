/**
 * Bug fix test (2026-06-24): recipe / agent tool calls were never recorded to
 * the bridge ActivityLog — only MCP-session tool calls went through
 * `activityLog.record()` (src/transport.ts). The dashboard tool-call
 * telemetry ("TOOLS CALLED TODAY", /analytics) therefore read ZERO for all
 * recipe-driven work.
 *
 * Fix: instrument the shared tool chokepoint `toolRegistry.executeTool`, which
 * both the flat (yaml) runner and the chained runner funnel through. Both
 * runners must produce an ActivityLog entry per actual tool execution.
 *
 * Per Bug Fix Protocol: these tests MUST fail before the fix, pass after.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../../activityLog.js";
import type { ChainedRecipe } from "../chainedRunner.js";
import {
  buildChainedDeps,
  dispatchRecipe,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "runner-activitylog-"));

afterEach(() => {
  // best-effort cleanup of any files written
});

function baseDeps(activityLog: ActivityLog): RunnerDeps {
  return {
    now: () => new Date("2026-06-24T08:00:00Z"),
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    readFile: () => "",
    activityLog,
  };
}

describe("flat (yaml) runner — records tool calls to ActivityLog", () => {
  it("records a file.write tool execution", async () => {
    const activityLog = new ActivityLog();
    const recipe: YamlRecipe = {
      name: "flat-activitylog",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.write",
          path: path.join(tmpDir, "flat.md"),
          content: "hello",
        },
      ],
    };

    const result = await runYamlRecipe(recipe, baseDeps(activityLog));
    expect(result.stepsRun).toBe(1);

    const stats = activityLog.stats();
    expect(stats["file.write"]).toBeDefined();
    expect(stats["file.write"]?.count).toBeGreaterThanOrEqual(1);
  });
});

describe("chained runner — records tool calls to ActivityLog", () => {
  it("records a file.write tool execution through buildChainedDeps", async () => {
    const activityLog = new ActivityLog();
    const recipe = {
      name: "chained-activitylog",
      trigger: { type: "chained" },
      steps: [
        {
          id: "s1",
          tool: "file.write",
          path: path.join(tmpDir, "chained.md"),
          content: "hi",
        },
      ],
    } as unknown as ChainedRecipe & { trigger: { type: string } };

    // Mirror the production wiring (recipeOrchestration.ts): runnerDeps carries
    // activityLog, and chainedDeps is built from those same runnerDeps so the
    // resolved StepDeps reach the executeTool chokepoint with activityLog.
    const runnerDeps = baseDeps(activityLog);
    await dispatchRecipe(recipe as unknown as YamlRecipe, {
      ...runnerDeps,
      chainedDeps: buildChainedDeps(runnerDeps),
      chainedOptions: { activityLog },
    });

    const stats = activityLog.stats();
    expect(stats["file.write"]).toBeDefined();
    expect(stats["file.write"]?.count).toBeGreaterThanOrEqual(1);
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
