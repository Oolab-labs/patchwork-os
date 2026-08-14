/**
 * The ADR-0022 flip gate: what does the new store actually buy?
 *
 * ## The gate as written is no longer satisfiable, and that is a finding
 *
 * ADR-0022 §4 says the flip requires replaying #1324, #1340 and rotation loss
 * against both stores, with JSONL visibly LOSING all three. Checked against the
 * code today, two of those three no longer reproduce:
 *
 *  - #1324 (seq collides across instances) was fixed IN PLACE. `runKey()` keys
 *    on `taskId`, so JSONL resolves the collision at read time and loses
 *    nothing.
 *  - #1340 (in-flight steps never written) was fixed IN PLACE. `append()`
 *    persists to a sibling ledger and `loadStepEvidence` folds it back.
 *
 * That criterion was written while those bugs were fresh; the fixes landed and
 * the gate was not revisited. Demanding a loss that can no longer happen would
 * leave the flip permanently blocked — or, worse, invite quietly waiving the
 * gate, which is how a gate stops meaning anything.
 *
 * So this file tests what is TRUE today rather than what was true in June, and
 * says so. Only ONE of the three still separates the stores by losing data:
 *
 *  - ROTATION. `runs.jsonl` is capped at 1 MB live plus an 8 MB archive, and
 *    trims the OLDEST rows. Those rows are gone — not archived, not
 *    recoverable. The SQLite store has no such cap.
 *
 * The other two are now differences in KIND rather than in loss: JSONL
 * resolves a collision when reading, SQLite refuses it when writing. Better,
 * but not a loss, and this file does not pretend otherwise.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipeRun } from "../../runLog.js";
import { MAX_PERSIST_LINES, RecipeRunLog } from "../../runLog.js";
import { SqliteRunRepository } from "../sqliteRunRepository.js";

describe("ADR-0022 flip gate — what the new store actually buys", () => {
  let dir: string;
  let mirrors: SqliteRunRepository[];
  let logs: RecipeRunLog[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flipgate-"));
    mirrors = [];
    logs = [];
  });
  afterEach(() => {
    for (const l of logs) l.close();
    for (const m of mirrors) m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const openMirror = () => {
    const m = new SqliteRunRepository({ dir: path.join(dir, "mirror") });
    mirrors.push(m);
    return m;
  };

  /**
   * Caps shrunk from 1 MB / 8 MB to 8 KB / 24 KB.
   *
   * The MECHANISM is what matters — trim the oldest, bound the archive, drop
   * what falls off — and it is identical at any scale. Running it at the real
   * magnitude means ~10.5 MB of writes and ~10 whole-file rewrites, which was
   * comfortable on macOS and pushed the Windows CI job past its 10-minute
   * ceiling, killing the entire suite. Testing the magnitude tests the
   * filesystem; testing the mechanism tests the code.
   */
  const SMALL_LIVE = 8 * 1024;
  const SMALL_ARCHIVE = 24 * 1024;

  /** ~2 KB serialized, like a real run carrying an `outputTail`. */
  const bulkyRun = (i: number): Omit<RecipeRun, "seq"> => ({
    taskId: `bulk-${i}`,
    recipeName: "noisy-neighbour",
    trigger: "cron",
    status: "done",
    createdAt: 1_000 + i,
    doneAt: 2_000 + i,
    durationMs: 1_000,
    outputTail: "x".repeat(2_000),
  });

  /**
   * THE decisive difference, and the reason ADR-0022 exists.
   *
   * `runs.jsonl` measures retention in BYTES while the trust system measures
   * durability in TIME, and nothing reconciles the two. A high-frequency
   * recipe therefore evicts a worker's filing before it can settle — which is
   * not slow trust, it is trust that cannot be earned in principle. Every row
   * here belongs to ONE noisy recipe, exactly as `gigsecure-withdrawal-alert`
   * held 85% of the live log.
   */
  it("JSONL loses the oldest evidence to rotation; SQLite does not", () => {
    const log = new RecipeRunLog({
      dir,
      memoryCap: MAX_PERSIST_LINES,
      maxPersistBytes: SMALL_LIVE,
      maxArchiveBytes: SMALL_ARCHIVE,
    });
    logs.push(log);
    const mirror = openMirror();

    // The row whose survival we care about: a worker filing, written first,
    // then buried under unrelated traffic.
    const filing: Omit<RecipeRun, "seq"> = {
      taskId: "worker-filing-that-must-survive",
      recipeName: "butler-errand",
      trigger: "cron",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
    };
    log.appendDirect(filing);
    for (const r of log.query({ limit: 5 })) mirror.mirrorRow(r);

    // Bury it: enough bulk to exceed 1 MB live AND the 8 MB archive.
    // ~80 KB against 8 KB + 24 KB of capacity — several rotations, and the
    // oldest rows pushed out of the archive entirely.
    const BULK = 40;
    for (let i = 0; i < BULK; i++) {
      log.appendDirect(bulkyRun(i));
      const [newest] = log.query({ limit: 1 });
      if (newest) mirror.mirrorRow(newest);
    }

    const liveBytes = statSync(path.join(dir, "runs.jsonl")).size;
    expect(
      liveBytes,
      "the live file must have rotated at least once",
    ).toBeLessThan(SMALL_LIVE * 3);

    // Guard against passing vacuously: an EMPTY log would also "lose" the row.
    const readable = log.query({ limit: MAX_PERSIST_LINES });
    expect(
      readable.length,
      "the log must still hold rows, or absence proves nothing",
    ).toBeGreaterThan(0);
    expect(
      existsSync(path.join(dir, "runs.jsonl.1")),
      "rotation must have occurred, or nothing was evicted",
    ).toBe(true);

    // JSONL: gone from the live file AND the archive — asserted against the
    // RAW BYTES, not only through a reader. A reader could omit the row for
    // its own reasons (a cap, a filter); the bytes cannot.
    const liveRaw = readFileSync(path.join(dir, "runs.jsonl"), "utf-8");
    const archiveRaw = readFileSync(path.join(dir, "runs.jsonl.1"), "utf-8");
    expect(
      liveRaw.includes(filing.taskId) || archiveRaw.includes(filing.taskId),
      "JSONL is expected to LOSE this row from disk entirely — if it survived, " +
        "the caps or the volume changed and this test no longer demonstrates anything",
    ).toBe(false);
    // ...and a FRESH reader agrees with the bytes.
    //
    // Fresh, not `log`, and the distinction is the point. The instance that
    // wrote the row still holds it in its in-memory ring, so it keeps
    // answering with data that no longer exists on disk. The loss only becomes
    // visible to a process that reads the file cold — i.e. after a bridge
    // restart, or to the trust replay, which is exactly how this class of bug
    // stays hidden while someone is watching a live dashboard.
    const fresh = new RecipeRunLog({
      dir,
      memoryCap: MAX_PERSIST_LINES,
      maxPersistBytes: SMALL_LIVE,
      maxArchiveBytes: SMALL_ARCHIVE,
    });
    logs.push(fresh);
    expect(
      fresh
        .query({ limit: MAX_PERSIST_LINES })
        .some((r) => r.taskId === filing.taskId),
      "a cold reader must not see the evicted row",
    ).toBe(false);
    expect(fresh.readArchive().some((r) => r.taskId === filing.taskId)).toBe(
      false,
    );
    // The writing instance still serves it from memory — recorded because it
    // is the reason the eviction goes unnoticed, not an incidental detail.
    expect(
      readable.some((r) => r.taskId === filing.taskId),
      "the writing instance still has it cached — this is why the loss is silent",
    ).toBe(true);

    // SQLite: still there.
    const survived = mirror
      .query({ limit: 50_000 })
      .some((r) => r.taskId === filing.taskId);
    expect(survived, "SQLite must retain what JSONL evicted").toBe(true);
  }, 120_000);

  /**
   * #1324 today: a DIFFERENCE IN KIND, not a loss.
   *
   * Recorded so nobody re-derives the gate from the ADR text and concludes the
   * migration is unjustified when JSONL declines to lose anything here. JSONL
   * resolves the collision when READING; SQLite refuses it when WRITING.
   * Prevention beats resolution — a constraint cannot be forgotten by a future
   * reader — but it is not evidence loss, and calling it one would be dressing
   * up the case.
   */
  it("both stores survive colliding seqs — JSONL by resolving, SQLite by refusing", () => {
    const a = new RecipeRunLog({ dir });
    const b = new RecipeRunLog({ dir });
    logs.push(a, b);
    const mirror = openMirror();

    // Two instances, both starting from an empty file, both minting seq 1.
    const seqA = a.startRun({
      taskId: "task-A",
      recipeName: "one",
      trigger: "cron",
      createdAt: 1_000,
    });
    const seqB = b.startRun({
      taskId: "task-B",
      recipeName: "two",
      trigger: "cron",
      createdAt: 2_000,
    });
    expect(seqA, "the collision this test depends on must occur").toBe(seqB);

    for (const r of new RecipeRunLog({ dir }).query({ limit: 50 }))
      mirror.mirrorRow(r);

    const jsonlIds = new RecipeRunLog({ dir })
      .query({ limit: 50 })
      .map((r) => r.taskId)
      .sort();
    const sqliteIds = mirror
      .query({ limit: 50 })
      .map((r) => r.taskId)
      .sort();

    expect(jsonlIds).toEqual(["task-A", "task-B"]);
    expect(sqliteIds).toEqual(["task-A", "task-B"]);
  });
});
