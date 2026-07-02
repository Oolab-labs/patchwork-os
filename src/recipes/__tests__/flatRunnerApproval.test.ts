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
import { cancelRun } from "../runRegistry.js";
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
    // Persist to the temp logDir (never homedir) — the run-registry / cancel
    // tests need the runController registered, which is gated on `!testMode`.
    // Under the VITEST-aware default, testMode would otherwise default ON. See
    // runLogIsolation.test.ts.
    testMode: false,
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

/**
 * worker.autonomy flip — `gateAutomatedRuns` makes the SAME gate engage on
 * automated triggers too (that's how workers run). Off → byte-identical to the
 * manual-only behaviour above.
 */
describe("flat-runner approval gate — gateAutomatedRuns (worker.autonomy)", () => {
  it("engages on a CRON trigger when gateAutomatedRuns is set", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(
      async (i: { params?: Record<string, unknown> }) =>
        i.params?.path !== `${TMP}/b`, // reject the 2nd step
    );
    const result = await runYamlRecipe(
      recipe({ type: "cron" }),
      deps({
        requireApprovalFn,
        gateAutomatedRuns: true,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(2); // consulted on cron
    expect(writes).toBe(1); // rejected step did not write
    expect(result.errorMessage).toMatch(/approval_rejected/);
  });

  it("runs an automated worker recipe unblocked when every step is approved", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(
      recipe({ type: "cron" }),
      deps({
        requireApprovalFn,
        gateAutomatedRuns: true,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(2);
    expect(writes).toBe(2);
  });

  it("withOUT gateAutomatedRuns a cron NEVER consults the gate (flag-off parity)", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => false); // would reject everything
    await runYamlRecipe(
      recipe({ type: "cron" }),
      deps({
        requireApprovalFn,
        // gateAutomatedRuns omitted → manual-only, identical to pre-flip
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(writes).toBe(2);
  });

  it("respects requireApproval:false opt-out even with gateAutomatedRuns", async () => {
    let writes = 0;
    const requireApprovalFn = vi.fn(async () => false);
    await runYamlRecipe(
      recipe({ type: "cron" }, { requireApproval: false }),
      deps({
        requireApprovalFn,
        gateAutomatedRuns: true,
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(writes).toBe(2);
  });
});

/**
 * L1 (review #1028) — the flat runner must forward the LIVE run signal
 * (runController.signal, aborted by POST /runs/:seq/cancel) into the approval
 * wait, not just deps.signal (undefined in production). Cancelling a registered
 * run must abort a pending approval instead of hanging the full TTL.
 */
describe("flat-runner approval gate — cancel aborts a pending approval (L1)", () => {
  it("forwards the run-registry signal so cancelRun(seq) resolves the wait", async () => {
    const SEQ = 919191;
    // minimal runLog stub so the runner registers a runController for SEQ
    const runLog = {
      startRun: () => SEQ,
      updateRunSteps: () => {},
      completeRun: () => {},
    } as unknown as RunnerDeps["runLog"];

    let captured: AbortSignal | undefined;
    // mimic the real ApprovalQueue: resolve false ("cancelled") on abort, else hang
    const requireApprovalFn = vi.fn(async (i: { signal?: AbortSignal }) => {
      captured = i.signal;
      if (i.signal?.aborted) return false;
      return new Promise<boolean>((resolve) => {
        i.signal?.addEventListener("abort", () => resolve(false));
      });
    });

    const p = runYamlRecipe(
      recipe({ type: "manual" }),
      deps({ runLog, requireApprovalFn }),
    );
    await new Promise((r) => setImmediate(r));
    // the approval wait received the LIVE run signal (not undefined)
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);

    cancelRun(SEQ); // POST /runs/:seq/cancel equivalent
    expect(captured?.aborted).toBe(true); // pending approval is aborted, not hung

    const result = await p;
    expect(result.errorMessage).toMatch(/approval_rejected/);
  });
});
