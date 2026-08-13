/**
 * Guarantees the SHARED contract cannot express, because the incumbent cannot
 * satisfy them. These are the properties ADR-0022 is actually buying.
 *
 * The conformance suite deliberately holds both stores to behaviour JSONL
 * already has — a contract the incumbent fails is a wish, not a contract. So
 * the reasons for migrating live here instead, asserted directly.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRunRepository } from "../sqliteRunRepository.js";

describe("SQLite run store — what JSONL could not do", () => {
  let dir: string;
  let opened: SqliteRunRepository[] = [];

  /** Track every instance so teardown can close it. An open file cannot be
   *  unlinked on Windows, so a leaked handle makes `rmSync` throw EBUSY there
   *  while POSIX deletes it silently — invisible locally, 57 failures in CI. */
  const open = (): SqliteRunRepository => {
    const r = new SqliteRunRepository({ dir });
    opened.push(r);
    return r;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sqlite-runstore-"));
    opened = [];
  });
  afterEach(() => {
    for (const r of opened) r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (
    repo: SqliteRunRepository,
    taskId: string,
    createdAt = 1_000,
  ) =>
    repo.startRun({
      taskId,
      recipeName: "demo",
      trigger: "cron",
      createdAt,
    });

  it("writes a real database file", () => {
    const repo = open();
    start(repo, "t-file");
    const db = path.join(dir, "runs.db");
    expect(existsSync(db)).toBe(true);
    expect(statSync(db).size).toBeGreaterThan(0);
  });

  /**
   * #1324, as a schema constraint rather than a convention.
   *
   * `seq` is a per-instance counter handed out by eight construction sites, so
   * two live instances give the SAME seq to unrelated runs — 142 of 145 in the
   * live log. JSONL had no way to refuse that; the collision was resolved at
   * READ time by a dedupe that discarded two-thirds of the run history.
   *
   * Here two runs colliding on `seq` are simply two rows, because identity is
   * `task_id`. Nothing is discarded and nothing has to be reconciled.
   */
  it("two runs with the same seq both survive (#1324)", () => {
    const a = open();
    const b = open();

    // `b` was constructed before `a` wrote anything, so both counters start at
    // 0 and both hand out seq 1 — precisely the live-log collision.
    const seqA = start(a, "task-A", 1_000);
    const seqB = start(b, "task-B", 2_000);
    expect(seqA, "the collision this test depends on must actually occur").toBe(
      seqB,
    );

    const ids = open()
      .query({ limit: 50 })
      .map((r) => r.taskId)
      .sort();
    expect(ids).toEqual(["task-A", "task-B"]);
  });

  /** The same identity rule from the other side: one task is one row, however
   *  many times it is started. An accidental re-start updates rather than
   *  duplicating, so a run cannot fork into two histories. */
  it("re-starting the same taskId does not create a second run", () => {
    const repo = open();
    start(repo, "t-dup");
    start(repo, "t-dup");
    expect(repo.size()).toBe(1);
  });

  /**
   * There is no byte cap, line cap, rotation or archive tier — by design.
   * `runs.jsonl`'s 1 MB cap is what starved the trust ledger: retention is
   * measured in BYTES while the durability window is defined in TIME, and
   * nothing reconciled them, so a busy recipe could delete a worker's filing
   * before it could settle.
   */
  it("retains far more rows than the JSONL cap would have held", () => {
    const repo = open();
    for (let i = 0; i < 5_000; i++) {
      const seq = repo.startRun({
        taskId: `bulk-${i}`,
        recipeName: "noisy",
        trigger: "cron",
        createdAt: 1_000 + i,
      });
      repo.completeRun(seq, {
        status: "done",
        doneAt: 2_000 + i,
        durationMs: 1,
        stepResults: [],
      });
    }
    expect(repo.size()).toBe(5_000);
    // And the oldest is still there — the property that actually matters, since
    // rotation dropped precisely the oldest rows.
    expect(repo.query({ limit: 1, recipe: "noisy", since: 1_000 }).length).toBe(
      1,
    );
    const all = repo.query({ limit: 10_000 });
    expect(all[all.length - 1]?.taskId).toBe("bulk-0");
  });
});
