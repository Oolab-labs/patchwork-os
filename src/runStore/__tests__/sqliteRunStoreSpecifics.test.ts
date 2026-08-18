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
   *
   * ROWS is chosen against a measurement, not picked round. The live log held
   * 1,123 rows in 851,327 bytes (~758 B/row), so the 1 MB cap lands near
   * ~1,380 rows. 2,000 clears it decisively while staying honest about what is
   * being demonstrated.
   *
   * The generous timeout is for Windows, not for slack: each commit is its own
   * WAL transaction, and Windows fsync (plus Defender) is far slower. MEASURED
   * (#1386, PR #1442) for 4,000 commits: macOS 271 ms (14,755 commits/s),
   * ubuntu 673-1,276 ms, windows-latest 18.6-19.8 s (~202 commits/s) — Windows
   * is ~73x slower than macOS. The store is not slow; per-row transactions are,
   * and production writes one run at a time.
   *
   * Why only a SAMPLE is completed. At 4,000 commits this sat ~19 s against the
   * 60 s timeout — 3.2x headroom — and a contention spike on windows-latest ate
   * it, timing out all three CI retries while the Test step on the same runner
   * passed (#1386 cause 2). Raising the timeout is the wrong lever: `retry: 2`
   * means three attempts and the Coverage step's budget is `timeout-minutes: 8`
   * against a ~6.4 min run, so 120 s would blow the STEP timeout instead and
   * trade a diagnosable failure for an undiagnosable kill.
   *
   * Halving the commits is the right lever, because the second commit per row
   * was never load-bearing HERE: this test asserts row RETENTION, and `query`
   * only adds a status clause when one is passed. Completing a sample at both
   * ends keeps the realistic start+complete path exercised — including on
   * `bulk-0`, the oldest row, which is what the rotation assertion turns on —
   * and the `status: "done"` assertion below makes the sample load-bearing, so
   * dropping completeRun entirely fails rather than silently passing.
   *
   * ~2,100 commits ≈ 10 s on windows-latest: ~5.7x headroom, worst case
   * unchanged at 3 x 60 s.
   */
  it("retains far more rows than the JSONL cap would have held", {
    timeout: 60_000,
  }, () => {
    const repo = open();
    const ROWS = 2_000;
    const COMPLETED_SAMPLE = 50;
    for (let i = 0; i < ROWS; i++) {
      const seq = repo.startRun({
        taskId: `bulk-${i}`,
        recipeName: "noisy",
        trigger: "cron",
        createdAt: 1_000 + i,
      });
      if (i < COMPLETED_SAMPLE || i >= ROWS - COMPLETED_SAMPLE) {
        repo.completeRun(seq, {
          status: "done",
          doneAt: 2_000 + i,
          durationMs: 1,
          stepResults: [],
        });
      }
    }
    expect(repo.size()).toBe(ROWS);
    // Keeps the completion path load-bearing: without this, deleting the
    // completeRun call above would still pass every other assertion.
    expect(repo.query({ status: "done" }).length).toBe(COMPLETED_SAMPLE * 2);
    // And the oldest is still there — the property that actually matters, since
    // rotation dropped precisely the oldest rows.
    expect(repo.query({ limit: 1, recipe: "noisy", since: 1_000 }).length).toBe(
      1,
    );
    const all = repo.query({ limit: 10_000 });
    expect(all[all.length - 1]?.taskId).toBe("bulk-0");
  });
});
