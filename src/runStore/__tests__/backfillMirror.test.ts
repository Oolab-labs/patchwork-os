/**
 * Backfill + compare — the migration rehearsed on a small scale.
 *
 * These exist because the same code was first run against the REAL log
 * (1,123 raw lines → 424 runs) and found two things a green unit test would
 * not have: the mirror normalising an absent `hadStepErrors` into an explicit
 * `false` (52 spurious differences), and a counter that structurally could
 * never fire. Both are pinned here so neither can come back.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipeRun } from "../../runLog.js";
import {
  backfillMirror,
  compareStores,
  formatCompare,
} from "../backfillMirror.js";
import { SqliteRunRepository } from "../sqliteRunRepository.js";

describe("backfill + compare", () => {
  let dir: string;
  let mirrors: SqliteRunRepository[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "backfill-"));
    mirrors = [];
  });
  afterEach(() => {
    for (const m of mirrors) m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const openMirror = () => {
    const m = new SqliteRunRepository({
      dir: path.join(dir, "runstore-mirror"),
    });
    mirrors.push(m);
    return m;
  };

  const row = (over: Partial<RecipeRun> = {}): RecipeRun =>
    ({
      seq: 1,
      taskId: "t-1",
      recipeName: "demo",
      trigger: "cron",
      status: "done",
      createdAt: 1_000,
      doneAt: 2_000,
      durationMs: 1_000,
      ...over,
    }) as RecipeRun;

  /** Write raw JSONL, exactly as the run log would have. */
  const writeLog = (rows: RecipeRun[], file = "runs.jsonl") =>
    writeFileSync(
      path.join(dir, file),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );

  it("seeds the mirror and the two then agree", () => {
    writeLog([row({ seq: 1, taskId: "a" }), row({ seq: 2, taskId: "b" })]);
    const mirror = openMirror();

    const result = backfillMirror(dir, mirror);
    expect(result.sourceRows).toBe(2);
    expect(result.mirrorRows).toBe(2);
    expect(compareStores(dir, mirror).agree).toBe(true);
  });

  /**
   * The bug the real-data rehearsal found. A row written before
   * `hadStepErrors` existed has it ABSENT; the mirror stored `false`, and 52
   * real runs reported as different. Mirroring must reproduce its source, not
   * improve it — an observer that quietly normalises cannot be used to judge
   * whether the source was reproduced.
   */
  it("an absent hadStepErrors stays absent, it does not become false", () => {
    const r = row({ taskId: "no-flag" });
    delete (r as Partial<RecipeRun>).hadStepErrors;
    writeLog([r]);
    const mirror = openMirror();

    backfillMirror(dir, mirror);

    const mirrored = mirror.query({ limit: 10 })[0];
    expect(mirrored?.hadStepErrors).toBeUndefined();
    expect(compareStores(dir, mirror).agree).toBe(true);
  });

  it("a genuine hadStepErrors:true survives", () => {
    writeLog([row({ taskId: "flagged", hadStepErrors: true })]);
    const mirror = openMirror();
    backfillMirror(dir, mirror);
    expect(mirror.query({ limit: 10 })[0]?.hadStepErrors).toBe(true);
  });

  /** Re-running must be a no-op, not a duplication — an operator will run it
   *  twice, and a backfill that grows each time is unusable as a rehearsal. */
  it("is idempotent", () => {
    writeLog([row({ seq: 1, taskId: "a" }), row({ seq: 2, taskId: "b" })]);
    const mirror = openMirror();

    backfillMirror(dir, mirror);
    const second = backfillMirror(dir, mirror);

    expect(second.mirrorRows).toBe(2);
    expect(compareStores(dir, mirror).agree).toBe(true);
  });

  /**
   * Raw lines exceed distinct runs because a run appends a "running" row and
   * later a terminal one. Reported so the numbers reconcile — otherwise the
   * mirror looks like it dropped most of the history. On the live log this is
   * 1,123 lines against 424 runs.
   */
  it("reports raw lines separately from distinct runs", () => {
    writeLog([
      row({ seq: 1, taskId: "a", status: "running" }),
      row({ seq: 1, taskId: "a", status: "done" }),
      row({ seq: 2, taskId: "b" }),
    ]);
    const mirror = openMirror();

    const result = backfillMirror(dir, mirror);
    expect(result.rawSourceLines).toBe(3);
    expect(result.sourceRows, "distinct runs, last row winning").toBe(2);
    expect(result.mirrorRows).toBe(2);
    // The surviving row must be the TERMINAL one, as every JSONL reader sees.
    expect(
      mirror.query({ limit: 10 }).find((r) => r.taskId === "a")?.status,
    ).toBe("done");
  });

  it("counts the rotation archive as source too", () => {
    writeLog([row({ seq: 9, taskId: "archived" })], "runs.jsonl.1");
    writeLog([row({ seq: 10, taskId: "live" })]);
    const mirror = openMirror();

    const result = backfillMirror(dir, mirror);
    expect(result.rawSourceLines).toBe(2);
    expect(result.mirrorRows).toBe(2);
  });

  describe("compare detects real disagreement", () => {
    it("a run missing from the mirror", () => {
      writeLog([row({ seq: 1, taskId: "a" }), row({ seq: 2, taskId: "b" })]);
      const mirror = openMirror();
      backfillMirror(dir, mirror);

      // Add a run to the source only.
      writeLog([
        row({ seq: 1, taskId: "a" }),
        row({ seq: 2, taskId: "b" }),
        row({ seq: 3, taskId: "c" }),
      ]);

      const r = compareStores(dir, mirror);
      expect(r.agree).toBe(false);
      expect(r.missingFromMirror).toEqual(["c"]);
    });

    it("a field that disagrees", () => {
      writeLog([row({ seq: 1, taskId: "a", status: "done" })]);
      const mirror = openMirror();
      backfillMirror(dir, mirror);

      writeLog([row({ seq: 1, taskId: "a", status: "error" })]);

      const r = compareStores(dir, mirror);
      expect(r.agree).toBe(false);
      expect(r.fieldDifferences[0]?.taskId).toBe("a");
      expect(r.fieldDifferences[0]?.differences.join(" ")).toContain("status");
    });
  });

  /** Agreement is STATED, not implied by silence — silence is ambiguous with
   *  a command that did nothing. */
  it("formats agreement explicitly", () => {
    writeLog([row({ taskId: "a" })]);
    const mirror = openMirror();
    backfillMirror(dir, mirror);
    expect(formatCompare(compareStores(dir, mirror))).toContain("AGREE");
  });
});
