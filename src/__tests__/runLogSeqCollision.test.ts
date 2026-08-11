import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../runLog.js";

/**
 * `seq` is a per-INSTANCE counter (`private seq = 0`, seeded from the file at
 * construction, then `++this.seq` per append) but `runs.jsonl` is a SHARED
 * file with eight construction sites, several of which write. Two instances
 * constructed around the same time therefore hand out the same seq to
 * completely unrelated runs.
 *
 * That is not hypothetical: in the live log, 142 of 145 seqs were shared by
 * more than one taskId, and the colliding runs were a median 20 minutes and up
 * to 5.6 hours apart — long-lived concurrent instances, not a millisecond race.
 *
 * Because the log deduped by seq, 463 real runs collapsed to 146 visible ones.
 * The run log is also the trust ledger, so two-thirds of the evidence the
 * autonomy gate reasons about was being discarded on every read.
 *
 * `taskId` is the correct key: across the whole live log, no taskId disagreed
 * with itself on `createdAt` and none spanned two recipes.
 */
describe("run log: colliding seqs must not destroy runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runlog-collision-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const row = (seq: number, taskId: string, recipeName: string, at: number) =>
    JSON.stringify({
      seq,
      taskId,
      recipeName,
      trigger: "recipe",
      status: "done",
      createdAt: at,
      doneAt: at,
      durationMs: 1,
      stepResults: [
        { id: "s1", tool: "file.write", status: "ok", durationMs: 1 },
      ],
    });

  function seed(lines: string[]) {
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      `${lines.join("\n")}\n`,
      "utf-8",
    );
  }

  it("keeps BOTH runs when two instances hand out the same seq", () => {
    seed([
      row(12540, "yaml:butler-errand:1", "butler-errand", 1000),
      row(12540, "yaml:gigsecure:2", "gigsecure-withdrawal-alert", 2000),
    ]);
    const log = new RecipeRunLog({ dir });
    const all = log.query({ limit: 500 });
    expect(all.map((r) => r.recipeName).sort()).toEqual([
      "butler-errand",
      "gigsecure-withdrawal-alert",
    ]);
  });

  it("a per-recipe query still finds the run the collision used to hide", () => {
    seed([
      row(12540, "yaml:butler-errand:1", "butler-errand", 1000),
      row(12540, "yaml:gigsecure:2", "gigsecure-withdrawal-alert", 2000),
    ]);
    const log = new RecipeRunLog({ dir });
    expect(log.query({ recipe: "butler-errand", limit: 500 })).toHaveLength(1);
  });

  it("still collapses the running -> terminal rows of ONE run", () => {
    // The dedup must not become a no-op: the log legitimately appends several
    // rows per run as it progresses, and those must still resolve to one.
    seed([
      JSON.stringify({
        seq: 1,
        taskId: "yaml:r:1",
        recipeName: "r",
        trigger: "recipe",
        status: "running",
        createdAt: 1000,
        doneAt: 0,
        durationMs: 0,
      }),
      row(1, "yaml:r:1", "r", 1000),
    ]);
    const log = new RecipeRunLog({ dir });
    const all = log.query({ limit: 500 });
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("done"); // last row wins
  });

  it("picks up a concurrent writer's run whose seq is NOT ahead of ours", () => {
    // syncFromDisk only ingested rows with `seq > this.seq`, so a second
    // process writing at an equal-or-lower seq was invisible to a live bridge
    // for as long as it stayed up — a separate loss from the load-time dedup.
    seed([row(10, "yaml:a:1", "a", 1000)]);
    // Drive the clock: syncFromDisk throttles disk stats to one per 250 ms, so
    // a same-tick re-query would return the cached ring and the assertion would
    // pass or fail for a reason unrelated to the dedup key.
    let clock = 0;
    const log = new RecipeRunLog({ dir, now: () => clock });
    expect(log.query({ limit: 500 })).toHaveLength(1);

    const f = path.join(dir, "runs.jsonl");
    const existing = readFileSync(f, "utf-8");
    writeFileSync(f, `${existing}${row(10, "yaml:b:2", "b", 2000)}\n`, "utf-8");
    clock += 1000;

    const after = log.query({ limit: 500 });
    expect(after.map((r) => r.recipeName).sort()).toEqual(["a", "b"]);
  });

  it("a disk re-read must not wipe live in-memory step progress", () => {
    // `updateRunSteps` mutates the in-memory row and never writes to disk, so a
    // running run's steps exist ONLY in memory. Removing the `seq > this.seq`
    // gate (needed to see concurrent writers) also removed the accidental
    // protection around them: the next sync would replace the live row with the
    // stale on-disk one and the dashboard's streaming steps would vanish.
    // Started through the log's own API: a `running` row seeded on disk is
    // flipped to `interrupted` by the startup sweep, so the test would be
    // exercising a dead run and could never observe the regression.
    let clock = 0;
    const log = new RecipeRunLog({ dir, now: () => clock });
    const seq = log.startRun({
      taskId: "yaml:live:1",
      recipeName: "live",
      trigger: "recipe",
      createdAt: 1000,
    });
    log.updateRunSteps(seq, [{ id: "s1", status: "ok", durationMs: 5 }]);
    expect(log.getBySeq(seq)?.stepResults).toHaveLength(1);

    clock += 1000; // force a real sync
    // Another writer appends an unrelated run, so the file grows and we re-read.
    const f = path.join(dir, "runs.jsonl");
    writeFileSync(
      f,
      `${readFileSync(f, "utf-8")}${row(seq, "yaml:other:2", "other", 3000)}\n`,
      "utf-8",
    );

    expect(
      log
        .query({ limit: 500 })
        .map((r) => r.recipeName)
        .sort(),
    ).toEqual(["live", "other"]);
    expect(
      log.getBySeq(seq)?.stepResults,
      "live step progress survived the sync",
    ).toHaveLength(1);
  });

  it("...but a TERMINAL row from disk still supersedes a live in-memory row", () => {
    // The guard must not become "never update a running run" — a concurrent
    // writer finishing our run has to be able to land its terminal status.
    let clock = 0;
    const log = new RecipeRunLog({ dir, now: () => clock });
    const seq = log.startRun({
      taskId: "yaml:fin:1",
      recipeName: "fin",
      trigger: "recipe",
      createdAt: 1000,
    });
    expect(log.getBySeq(seq)?.status).toBe("running");

    clock += 1000;
    const f = path.join(dir, "runs.jsonl");
    writeFileSync(
      f,
      `${readFileSync(f, "utf-8")}${row(seq, "yaml:fin:1", "fin", 1000)}\n`,
      "utf-8",
    );

    expect(log.query({ limit: 500 })[0]?.status).toBe("done");
  });
});
