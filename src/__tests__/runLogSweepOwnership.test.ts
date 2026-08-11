import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RecipeRun, RecipeRunLog } from "../runLog.js";

/**
 * `loadExisting`'s sweep marks every `status:"running"` row `interrupted` — the
 * recovery path for a bridge that died mid-run. It ran unconditionally, in the
 * constructor, against a file shared by EIGHT construction sites. So any
 * short-lived reader (a `patchwork` CLI verb, the dashboard, a second bridge)
 * declared every OTHER process's in-flight runs dead.
 *
 * That is not a cosmetic mislabel. `syncFromDisk` feeds the terminal row back
 * to the owning bridge (a terminal row beats a live one, by design), and
 * `completeRun` no-ops on a run that is no longer `"running"` — so the real
 * completion is never written. A run that SUCCEEDED records
 * `interrupted, steps: 0`, and `runs.jsonl` is the autonomy gate's evidence.
 *
 * The sweep now runs only for rows whose owning process is provably gone.
 * Where liveness is unknowable (a legacy row with no owner stamp) it sweeps,
 * preserving the previous behaviour for old logs.
 */
describe("run sweep respects a live owner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "runsweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function find(log: RecipeRunLog, taskId: string): RecipeRun | undefined {
    return log.query({ limit: 20 }).find((r) => r.taskId === taskId);
  }

  it("a concurrent reader does not kill a live run's record", () => {
    // Process A — the owning bridge, with a run genuinely in flight.
    const a = new RecipeRunLog({ dir });
    const seq = a.startRun({
      taskId: "live-run",
      recipeName: "butler-errand",
      trigger: "recipe",
      createdAt: Date.now(),
    });

    // Process B — any short-lived reader that opens the same log.
    const b = new RecipeRunLog({ dir });
    expect(find(b, "live-run")?.status).toBe("running");

    // A polls its own log the way the dashboard does, then finishes normally.
    a.query({ limit: 20 });
    a.completeRun(seq, {
      status: "done",
      doneAt: Date.now(),
      durationMs: 1000,
      stepResults: [
        { id: "s1", tool: "githubCreateIssue", status: "ok", durationMs: 5 },
      ],
    });

    const after = new RecipeRunLog({ dir });
    const final = find(after, "live-run");
    expect(final?.status).toBe("done");
    expect(final?.stepResults).toHaveLength(1);
  });

  it("still sweeps a run whose owner is gone — restart recovery is the point", () => {
    const a = new RecipeRunLog({ dir });
    a.startRun({
      taskId: "orphan-run",
      recipeName: "butler-errand",
      trigger: "recipe",
      createdAt: Date.now(),
      // A pid that cannot be alive. 0 and negative pids are not addressable
      // process ids, so this is "provably gone" rather than "unknown".
      ownerPid: -1,
    });

    const after = new RecipeRunLog({ dir });
    expect(find(after, "orphan-run")?.status).toBe("interrupted");
  });

  it("sweeps a legacy row that carries no owner stamp", () => {
    // Hand-write a pre-ownership row: liveness is unknowable, so the old
    // behaviour (sweep) must survive rather than leaving it stuck "running".
    const seed = new RecipeRunLog({ dir });
    seed.appendDirect({
      taskId: "legacy-run",
      recipeName: "butler-errand",
      trigger: "recipe",
      status: "running",
      createdAt: Date.now(),
      doneAt: Date.now(),
      durationMs: 0,
      stepResults: [],
    });

    const after = new RecipeRunLog({ dir });
    expect(find(after, "legacy-run")?.status).toBe("interrupted");
  });
});
