import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog, type RunStepResult } from "../runLog.js";

/**
 * A run's step results reached disk ONLY via `completeRun`'s single append —
 * `updateRunSteps` mutated the in-memory row and returned. Any interruption
 * (bridge restart, session death, SIGKILL) therefore erased the entire
 * evidence record of a run whose actions had ALREADY happened. Measured on a
 * live errand: approval in ~20 min → 0 steps recorded, status "interrupted";
 * the identical recipe approved in 12 s → 4 steps recorded.
 *
 * That matters beyond the dashboard: `runs.jsonl` is the autonomy gate's
 * outcome corpus, so a lost row is lost trust evidence for an action that was
 * really taken.
 *
 * The fix persists only EVIDENCE-BEARING steps as they complete (non-reversible
 * or errored, never reads, never agent steps per #1320) to a sibling ledger.
 * Volume is load-bearing, not fastidiousness: `runs.jsonl`'s byte budget is
 * exactly what starved the trust ledger to 17 h against a 24 h durability
 * window, so the in-flight writes deliberately do NOT land in that file.
 */
describe("in-flight step evidence survives an interruption", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "runstep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function step(over: Partial<RunStepResult> & { id: string }): RunStepResult {
    return { status: "ok", durationMs: 5, ...over };
  }

  /** Start a run, report steps, and abandon the instance without completing. */
  function crashAfterSteps(steps: RunStepResult[]): void {
    const log = new RecipeRunLog({ dir });
    const seq = log.startRun({
      taskId: "task-crash",
      recipeName: "errand",
      trigger: "recipe",
      createdAt: Date.now(),
    });
    log.updateRunSteps(seq, steps);
    // No completeRun — this is the interruption.
  }

  it("recovers non-reversible and errored steps after a restart", () => {
    crashAfterSteps([
      step({ id: "s1", tool: "getBufferContent" }), // read — reversible
      step({ id: "s2", tool: "githubCreateIssue" }), // irreversible
      step({ id: "s3", tool: "gitPush", status: "error", error: "rejected" }),
    ]);

    const reopened = new RecipeRunLog({ dir });
    const run = reopened
      .query({ limit: 10 })
      .find((r) => r.taskId === "task-crash");

    expect(run?.status).toBe("interrupted");
    const ids = (run?.stepResults ?? []).map((s) => s.id);
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
  });

  it("does not persist reversible reads — the byte budget is the constraint", () => {
    crashAfterSteps([
      step({ id: "r1", tool: "getBufferContent" }),
      step({ id: "r2", tool: "getGitStatus" }),
      step({ id: "r3", tool: "agent" }), // #1320 — never evidence, either way
    ]);

    const ledger = path.join(dir, "run_steps.jsonl");
    const written = existsSync(ledger)
      ? readFileSync(ledger, "utf-8").trim()
      : "";
    expect(written).toBe("");
  });

  it("keeps the completed path intact — completeRun still wins", () => {
    const log = new RecipeRunLog({ dir });
    const steps = [step({ id: "s1", tool: "githubCreateIssue" })];
    const seq = log.startRun({
      taskId: "task-done",
      recipeName: "errand",
      trigger: "recipe",
      createdAt: Date.now(),
    });
    log.updateRunSteps(seq, steps);
    log.completeRun(seq, {
      status: "done",
      doneAt: Date.now(),
      durationMs: 10,
      stepResults: steps,
    });

    const reopened = new RecipeRunLog({ dir });
    const run = reopened
      .query({ limit: 10 })
      .find((r) => r.taskId === "task-done");
    expect(run?.status).toBe("done");
    expect(run?.stepResults).toHaveLength(1);
  });
});
