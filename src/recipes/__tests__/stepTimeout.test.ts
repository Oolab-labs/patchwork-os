/**
 * Tests for `step.timeout_ms` — small-alternative to the abandoned worker
 * pool. Per-step wall-clock timeout via Promise.race; on timeout the step
 * halts with `step_timeout` halt category. Validates the tool's existing
 * try/catch path masks an in-flight tool gracefully (no bridge crash —
 * verified empirically via the categoriseHaltReason mapping).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { categoriseHaltReason } from "../haltCategory.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
import "../tools/index.js";
import { hasTool, registerTool } from "../toolRegistry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "step-timeout-"));
  // Register a deliberately-slow tool for timeout testing. Idempotent —
  // the registry throws on duplicate, so guard.
  if (!hasTool("test.sleep")) {
    registerTool({
      id: "test.sleep",
      namespace: "test",
      description: "Sleep N ms then return 'ok'. Test-only.",
      paramsSchema: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async ({ params }) => {
        const ms = typeof params.ms === "number" ? params.ms : 0;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return "ok";
      },
    });
  }
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  return {
    now: () => new Date("2026-05-20T08:00:00Z"),
    logDir: tmpDir,
    readFile: () => {
      throw new Error("not seeded");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

describe("step.timeout_ms", () => {
  it("halts the step when wall-clock exceeds timeout_ms", async () => {
    const recipe: YamlRecipe = {
      name: "timeout-fires",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "test.sleep",
          ms: 500,
          timeout_ms: 50,
        },
      ],
    } as unknown as YamlRecipe;
    const start = Date.now();
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    const elapsed = Date.now() - start;
    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(result.stepResults?.[0]?.haltReason).toMatch(/step_timeout/i);
    expect(categoriseHaltReason(result.stepResults?.[0]?.haltReason)).toBe(
      "step_timeout",
    );
    // Should fail fast — well under the sleep duration.
    expect(elapsed).toBeLessThan(450);
  });

  it("does not fire when step completes within timeout_ms", async () => {
    const recipe: YamlRecipe = {
      name: "timeout-headroom",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "test.sleep",
          ms: 20,
          timeout_ms: 500,
        },
      ],
    } as unknown as YamlRecipe;
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
  });

  it("no timeout_ms = no timeout (legacy behavior preserved)", async () => {
    const recipe: YamlRecipe = {
      name: "timeout-absent",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "test.sleep",
          ms: 30,
        },
      ],
    } as unknown as YamlRecipe;
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
  });
});
