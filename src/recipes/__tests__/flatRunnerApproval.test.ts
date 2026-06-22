/**
 * Flat-runner approval gate (M3).
 *
 * The gate is safe-by-default:
 *   - only engages for `manual`-triggered runs (cron/webhook/recipe never block);
 *   - only when the bridge injects `requireApprovalFn` (approvalGate != "off");
 *   - per-recipe opt-out via `requireApproval: false`;
 *   - a `false` result is an explicit human rejection → the run HALTS with
 *     haltCategory "approval_rejected" and later steps do not execute.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "flat-approval-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-06-22T12:00:00Z"),
    logDir: TMP,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  };
}

function recipe(
  trigger: { type: string },
  overrides: Partial<YamlRecipe> = {},
): YamlRecipe {
  return {
    name: "approval-flat",
    trigger,
    steps: [
      { tool: "file.write", path: `${TMP}/a`, content: "1" },
      { tool: "file.write", path: `${TMP}/b`, content: "2" },
    ],
    ...overrides,
  } as YamlRecipe;
}

describe("flat-runner approval gate", () => {
  it("halts the run when a manual step is rejected", async () => {
    let writes = 0;
    // Reject the 2nd step (b), allow the first.
    const requireApprovalFn = vi.fn(
      async (i: { params?: Record<string, unknown> }) => {
        return i.params?.path !== `${TMP}/b`;
      },
    );
    const result = await runYamlRecipe(
      recipe({ type: "manual" }),
      deps({
        requireApprovalFn,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(2);
    expect(writes).toBe(1); // only the approved step wrote
    const rejected = result.stepResults.find(
      (s) => s.haltCategory === "approval_rejected",
    );
    expect(rejected).toBeDefined();
    expect(result.errorMessage).toMatch(/approval_rejected/);
  });

  it("runs all steps when every manual step is approved", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(
      recipe({ type: "manual" }),
      deps({
        requireApprovalFn,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(2);
    expect(writes).toBe(2);
  });

  it("NEVER consults the gate for cron triggers (crons don't block)", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => false); // would reject everything
    await runYamlRecipe(
      recipe({ type: "cron" }),
      deps({
        requireApprovalFn,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(writes).toBe(2); // cron ran unblocked
  });

  it("per-recipe opt-out (requireApproval:false) skips the gate on manual runs", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => false);
    await runYamlRecipe(
      recipe({ type: "manual" }, { requireApproval: false }),
      deps({
        requireApprovalFn,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(writes).toBe(2);
  });

  it("is a no-op when no requireApprovalFn is injected (approvalGate off)", async () => {
    let writes = 0;
    await runYamlRecipe(
      recipe({ type: "manual" }),
      deps({
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(writes).toBe(2);
  });
});
