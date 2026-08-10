import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../../runLog.js";
import type { GraduationConfig } from "../graduation.js";
import { loadWorkerTrustForRecipe } from "../runWorkerShadow.js";
import {
  loadTrustCheckpoint,
  saveTrustCheckpoint,
  shouldIngestRun,
} from "../trustCheckpoint.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const WORKERS_DIR = path.join(process.cwd(), "templates", "workers");

/**
 * Backlog #10 — durable trust evidence.
 *
 * `WorkerLevelStore` is rebuilt from scratch on every `workers shadow` run by
 * replaying `~/.patchwork/runs.jsonl`, and `toJSONL()` was called by nothing in
 * production. So a worker's earned trust lived entirely inside whatever the run
 * log still happened to hold: when a run rotated out, the evidence it carried
 * stopped existing and the dial silently fell back.
 *
 * That is not a hypothetical. On 2026-08-10 the live logs held 75 confirmed
 * outcomes across 4 distinct issues, and NONE of the four URLs appeared
 * anywhere in the 773-run log they had to join against.
 *
 * The two properties that matter, and the reason each is here:
 *   1. Trust survives the run log. Rotation must not silently un-earn it.
 *   2. Replay does not double-count. A checkpoint that re-folds runs it has
 *      already seen would inflate a dial toward autonomy on no new evidence —
 *      strictly worse than losing it, because it fails *open*.
 */

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};
const W = "release-notes-worker";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "trust-checkpoint-"));
  file = path.join(dir, "worker_trust.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function earn(store: WorkerLevelStore, n: number, at = 0): void {
  for (let i = 0; i < n; i++) {
    store.apply(W, { toolName: "editText", good: true, at }, { cfg: CFG });
  }
}

describe("trust checkpoint", () => {
  it("survives the run log rotating out from under it", () => {
    const store = new WorkerLevelStore();
    earn(store, 12);
    const before = store.board(W);
    expect(before.length).toBeGreaterThan(0);
    expect(before[0]?.observations).toBe(12);

    saveTrustCheckpoint(file, store, {
      watermarkAt: 5_000,
      idsAtWatermark: [],
    });

    // The run log is now empty — every run that produced the evidence above has
    // rotated away. Before this module existed, this is exactly where the dial
    // went back to zero.
    const restored = loadTrustCheckpoint(file);
    const after = restored.store.board(W);
    expect(after).toEqual(before);
    expect(restored.watermarkAt).toBe(5_000);
  });

  it("does not re-fold a run it has already ingested", () => {
    const cp = { watermarkAt: 5_000, idsAtWatermark: ["release-notes@5000"] };
    // Strictly older — already folded into the checkpoint.
    expect(shouldIngestRun({ recipeName: "r", at: 4_999 }, cp)).toBe(false);
    // Exactly at the watermark AND already recorded by id.
    expect(
      shouldIngestRun({ recipeName: "release-notes", at: 5_000 }, cp),
    ).toBe(false);
    // Same millisecond but a different run — genuinely new evidence, and a
    // watermark alone (`at > watermark`) would have silently dropped it.
    expect(shouldIngestRun({ recipeName: "other", at: 5_000 }, cp)).toBe(true);
    // Newer than the checkpoint.
    expect(shouldIngestRun({ recipeName: "r", at: 5_001 }, cp)).toBe(true);
  });

  it("treats a missing checkpoint as no history, not as an error", () => {
    // Fail-soft: a first run on a machine that has never checkpointed must
    // behave exactly like today's in-memory path.
    const fresh = loadTrustCheckpoint(path.join(dir, "absent.jsonl"));
    expect(fresh.store.board(W)).toEqual([]);
    expect(fresh.watermarkAt).toBe(0);
  });

  it("treats a corrupt checkpoint as no history rather than crashing", () => {
    // A truncated write (power loss mid-append) must not brick the gate. Losing
    // trust is recoverable by replay; refusing to start is not.
    writeFileSync(file, '{"rec":"state","workerId":"x"\n{ broken');
    const salvaged = loadTrustCheckpoint(file);
    expect(salvaged.watermarkAt).toBe(0);
    expect(salvaged.store.board(W)).toEqual([]);
  });

  it("round-trips the audit event log, not just the dial", () => {
    // The event log is the compliance artifact ("prove this worker never acted
    // beyond its authority"). A checkpoint that saved levels but dropped events
    // would restore the dial while losing the evidence for how it got there.
    const store = new WorkerLevelStore();
    earn(store, 6);
    for (const at of [1_000, 2_000, 3_000, 4_000]) {
      store.apply(W, { toolName: "editText", good: true, at }, { cfg: CFG });
    }
    const events = store.events(W);
    expect(events.length).toBeGreaterThan(0);

    saveTrustCheckpoint(file, store, {
      watermarkAt: 4_000,
      idsAtWatermark: [],
    });
    expect(loadTrustCheckpoint(file).store.events(W)).toEqual(events);
  });
});

describe("trust checkpoint — wiring into the live-gate entry", () => {
  // The bug being fixed was not "no persistence code existed" — `toJSONL()` had
  // existed all along. It was that NOTHING CALLED IT. So these tests drive the
  // real entry point (`loadWorkerTrustForRecipe`, what the live gate reads)
  // rather than the checkpoint module in isolation.
  // Runs must be older than the 24h durability window to be SETTLED (and so
  // checkpointable); a `now` close to the run timestamps leaves them all in the
  // provisional tail, which is replayed and deliberately never persisted.
  const DAY = 24 * 60 * 60 * 1000;
  let pw: string;
  /** Monotonic run clock — successive appends must not reuse timestamps, or
   *  they look like runs the checkpoint has already folded. */
  let clock: number;

  beforeEach(() => {
    pw = mkdtempSync(path.join(os.tmpdir(), "pw-trust-wire-"));
    clock = 1;
  });
  afterEach(() => rmSync(pw, { recursive: true, force: true }));

  function appendRuns(n: number, recipeName = "release-notes"): void {
    const log = new RecipeRunLog({ dir: pw });
    for (let i = 0; i < n; i++) {
      const at = clock++;
      log.appendDirect({
        taskId: `${recipeName}-${at}`,
        recipeName,
        trigger: "recipe",
        status: "done",
        createdAt: at,
        doneAt: at,
        durationMs: 1,
        stepResults: [
          { id: "s1", tool: "editText", status: "ok", durationMs: 1 },
        ],
      });
    }
  }

  const load = (now: number, recipe = "release-notes") =>
    loadWorkerTrustForRecipe(recipe, {
      workersDir: WORKERS_DIR,
      patchworkDir: pw,
      now,
    });

  function observations(t: ReturnType<typeof load>): number {
    if (!t) return -1;
    return t.store
      .board(t.worker.id)
      .reduce((sum, row) => sum + row.observations, 0);
  }

  it("keeps earned trust after the run log rotates away", () => {
    appendRuns(8);
    const earned = observations(load(DAY * 2));
    expect(earned).toBe(8);

    // Rotation: the runs that produced the evidence are gone.
    rmSync(path.join(pw, "runs.jsonl"), { force: true });

    // Before the checkpoint was wired, this returned 0 — the worker silently
    // un-earned everything it had demonstrated, with no event recording it.
    expect(observations(load(DAY * 3))).toBe(earned);
  });

  it("does not re-count the same runs when replayed again", () => {
    appendRuns(8);
    expect(observations(load(DAY * 2))).toBe(8);
    // Same run log, fresh evaluation (a later `now` bucket defeats the memo).
    // A checkpoint without the watermark would report 16 here — inflating the
    // dial toward autonomy on no new evidence.
    expect(observations(load(DAY * 9))).toBe(8);
  });

  it("counts genuinely new runs on top of the checkpoint", () => {
    appendRuns(4);
    expect(observations(load(DAY * 2))).toBe(4);
    appendRuns(3);
    expect(observations(load(DAY * 9))).toBe(7);
  });

  it("keeps one recipe's replay from starving another's evidence", () => {
    // The reason checkpoints are per-recipe. `loadWorkerTrustForRecipe` filters
    // the replay to a single recipe, so a shared global watermark would be
    // advanced past every other recipe's runs by whichever ran first.
    appendRuns(5, "release-notes");
    appendRuns(5, "dependency-bump");
    expect(observations(load(DAY * 2, "release-notes"))).toBe(5);
    expect(observations(load(DAY * 2, "dependency-bump"))).toBe(5);
  });
});
