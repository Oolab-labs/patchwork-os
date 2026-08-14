/**
 * Wiring the ADR-0022 shadow mirror.
 *
 * Two things need proving here, and only one of them is about the flag.
 *
 * 1. OFF BY DEFAULT means *nothing changes* — no mirror directory, no
 *    behaviour difference. A migration that alters the system before anyone
 *    opts in is not a migration, it is a change.
 *
 * 2. ON means EVERY write path reaches the mirror. The mirror hangs off
 *    `append()` because that is the single chokepoint all five writers funnel
 *    through, and the value of that claim is exactly the value of the test
 *    that checks it: a writer missed by the mirror leaves it permanently
 *    short of rows, producing divergence reports that are true, meaningless,
 *    and quickly ignored.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipeRunLog } from "../../runLog.js";
import {
  createRecipeRunLog,
  mirrorEnabled,
  RUNSTORE_MIRROR_FLAG,
} from "../createRunLog.js";
import { SqliteRunRepository } from "../sqliteRunRepository.js";

const ON = { [RUNSTORE_MIRROR_FLAG]: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe("run-log mirror wiring", () => {
  let dir: string;
  let readers: SqliteRunRepository[];
  let logs: RecipeRunLog[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wire-mirror-"));
    readers = [];
    logs = [];
  });
  afterEach(() => {
    // Close the run logs too, not just the readers: with the mirror on, the
    // run log owns a database handle. Leaving it open makes `rmSync` throw
    // EBUSY on Windows while POSIX deletes the open file silently — the leak
    // is invisible on macOS and fails the whole file on windows-latest.
    for (const l of logs) l.close();
    for (const r of readers) r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a run log and track it for teardown. */
  const makeLog = (env: NodeJS.ProcessEnv, extra: object = {}) => {
    const l = createRecipeRunLog({ dir, env, ...extra });
    logs.push(l);
    return l;
  };

  const mirrorDir = () => path.join(dir, "runstore-mirror");
  const readMirror = () => {
    const r = new SqliteRunRepository({ dir: mirrorDir() });
    readers.push(r);
    return r;
  };

  const finishedRun = (taskId: string) => ({
    taskId,
    recipeName: "demo",
    trigger: "cron" as const,
    status: "done" as const,
    createdAt: 1_000,
    doneAt: 2_000,
    durationMs: 1_000,
  });

  describe("the flag itself", () => {
    it("is off unless explicitly enabled", () => {
      expect(mirrorEnabled({})).toBe(false);
      expect(mirrorEnabled({ [RUNSTORE_MIRROR_FLAG]: "1" })).toBe(true);
      expect(mirrorEnabled({ [RUNSTORE_MIRROR_FLAG]: "true" })).toBe(true);
    });

    /** An ambiguous value on a TRUST LEDGER must resolve to the behaviour we
     *  already trust, not to the new thing. "false" enabling a mirror would be
     *  a genuinely nasty surprise. */
    it("treats anything unrecognised as off", () => {
      for (const v of ["0", "false", "no", "", "off", "TRUE ", "yep"]) {
        expect(mirrorEnabled({ [RUNSTORE_MIRROR_FLAG]: v }), v).toBe(false);
      }
    });
  });

  describe("off (the default)", () => {
    it("creates no mirror and behaves as before", () => {
      const log = makeLog(OFF);
      log.appendDirect(finishedRun("t-off"));

      expect(existsSync(mirrorDir()), "no mirror directory").toBe(false);
      expect(log.query({ limit: 10 }).map((r) => r.taskId)).toEqual(["t-off"]);
    });
  });

  describe("on", () => {
    /**
     * The chokepoint claim, checked against every writer rather than asserted.
     * `appendDirect`, `record` and `startRun`/`completeRun` are three
     * different public entry points; all three must land in the mirror because
     * all three funnel through `append()`.
     */
    it("mirrors every write path", () => {
      const log = makeLog(ON);

      // 1. appendDirect — the dominant production path.
      log.appendDirect(finishedRun("t-direct"));

      // 2. record — the bridge's task-completion path.
      log.record({
        id: "t-record",
        triggerSource: "recipe:demo",
        status: "done",
        createdAt: 1_000,
        doneAt: 2_000,
      });

      // 3. startRun + completeRun — the lifecycle path.
      const seq = log.startRun({
        taskId: "t-lifecycle",
        recipeName: "demo",
        trigger: "cron",
        createdAt: 1_000,
      });
      log.completeRun(seq, {
        status: "done",
        doneAt: 2_000,
        durationMs: 1_000,
        stepResults: [],
      });

      const mirrored = readMirror()
        .query({ limit: 50 })
        .map((r) => r.taskId)
        .sort();
      expect(mirrored).toEqual(["t-direct", "t-lifecycle", "t-record"]);
    });

    it("mirrors rows identically, including seq", () => {
      const log = makeLog(ON);
      log.appendDirect(finishedRun("t-same"));

      const primary = log.query({ limit: 10 })[0];
      const mirrored = readMirror().query({ limit: 10 })[0];

      expect(mirrored?.seq).toBe(primary?.seq);
      expect(mirrored?.status).toBe(primary?.status);
      expect(mirrored?.createdAt).toBe(primary?.createdAt);
      expect(mirrored?.recipeName).toBe(primary?.recipeName);
    });

    /** A run that starts and later finishes writes TWO rows for one task.
     *  JSONL readers take the last; the mirror upserts. Both must end up
     *  saying the same thing, or every long-running run reports divergence. */
    it("a run that starts then finishes ends up terminal, not duplicated", () => {
      const log = makeLog(ON);
      const seq = log.startRun({
        taskId: "t-twice",
        recipeName: "demo",
        trigger: "cron",
        createdAt: 1_000,
      });
      log.completeRun(seq, {
        status: "done",
        doneAt: 2_000,
        durationMs: 1_000,
        stepResults: [],
      });

      const rows = readMirror().query({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("done");
    });

    /**
     * That `close()` genuinely RELEASES the handle, observable on every
     * platform.
     *
     * Written because deleting the factory's disposer was caught only by
     * Windows (EBUSY on teardown) and passed 7/7 on POSIX. A leak that one
     * platform reports and the others ignore is one most people never see.
     * Here the released handle is proved by USING it: once closed, the next
     * write can no longer reach the mirror and says so.
     */
    it("close() releases the mirror handle, not just the reference", () => {
      const warnings: string[] = [];
      const log = makeLog(ON, {
        logger: { warn: (m: string) => warnings.push(m) } as never,
      });
      log.appendDirect(finishedRun("t-before-close"));
      expect(warnings.filter((w) => w.includes("write failed"))).toEqual([]);

      log.close();

      // The row still lands in the authoritative store...
      log.appendDirect(finishedRun("t-after-close"));
      expect(log.query({ limit: 10 }).map((r) => r.taskId)).toContain(
        "t-after-close",
      );
      // ...and the mirror is genuinely gone, reported rather than silent.
      expect(
        warnings.some((w) => w.includes("shadow mirror write failed")),
        `expected a mirror-write failure after close; saw ${JSON.stringify(warnings)}`,
      ).toBe(true);
    });

    it("close() is idempotent", () => {
      const log = makeLog(ON);
      log.appendDirect(finishedRun("t-idem"));
      expect(() => {
        log.close();
        log.close();
      }).not.toThrow();
    });

    /** Fail-soft, same rule as the mirror itself: an OBSERVER that cannot
     *  start must not take down the store it is observing. */
    it("an unopenable mirror leaves a working run log", () => {
      // Occupy the mirror's directory path with a FILE, so mkdir/open fails.
      // The first draft of this test only *described* doing that and would
      // have passed with the mirror opening perfectly — a check that could
      // not fail.
      writeFileSync(mirrorDir(), "not a directory");
      expect(existsSync(mirrorDir())).toBe(true);

      const warnings: string[] = [];
      const log = makeLog(ON, {
        logger: { warn: (m: string) => warnings.push(m) } as never,
      });

      expect(() => log.appendDirect(finishedRun("t-soft"))).not.toThrow();
      expect(log.query({ limit: 10 }).map((r) => r.taskId)).toEqual(["t-soft"]);
      // ...and it said so, rather than disabling itself in silence.
      expect(warnings.some((w) => w.includes("shadow mirror disabled"))).toBe(
        true,
      );
    });
  });
});
