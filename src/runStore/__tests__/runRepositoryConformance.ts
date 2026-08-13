/**
 * The shared contract every `RunRepository` implementation must satisfy —
 * ADR-0022.
 *
 * WHY A SHARED SUITE. The migration's entire safety argument is "the new store
 * behaves like the one we already trust". That claim is only checkable if both
 * stores are held to one set of assertions written down in one place. Two
 * separately-written test files drift, and they drift silently in the
 * permissive direction: the new store's suite quietly omits the case it fails.
 *
 * HOW TO USE. Call `describeRunRepositoryContract` with a factory. The factory
 * receives a fresh directory per test and must return a repository over it,
 * plus a `reopen()` that constructs a SECOND independent instance over the SAME
 * storage — that is how cross-process durability is exercised, and it is where
 * every one of #1324 / #1340 / #1341 actually lived.
 *
 * WHAT THIS SUITE IS NOT. It is not the bug-replay comparison. Everything here
 * passes against JSONL today, by design — a contract the incumbent fails is a
 * wish, not a contract. The three known defects are asserted separately, where
 * JSONL is EXPECTED to lose (ADR-0022 §4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunStepResult } from "../../runLog.js";
import type { RunRepository } from "../runRepository.js";

export interface RepositoryHarness {
  repo: RunRepository;
  /** A second, independent instance over the same storage. */
  reopen: () => RunRepository;
}

export type RepositoryFactory = (dir: string) => RepositoryHarness;

/**
 * A step fixture.
 *
 * `tool` defaults to `http.post` — classified `irreversible` — because the
 * in-flight durability guarantee is SCOPED to evidence-bearing steps
 * (`isEvidenceBearing`: non-reversible, or any error). A reversible step such
 * as `file.write` is deliberately never written mid-flight, so using one as
 * the default fixture makes the durability assertion silently untestable. The
 * first draft of this suite did exactly that and read as a store defect.
 */
const step = (
  id: string,
  status: "ok" | "error" = "ok",
  tool = "http.post",
): RunStepResult => ({ id, tool, status }) as unknown as RunStepResult;

export function describeRunRepositoryContract(
  name: string,
  factory: RepositoryFactory,
): void {
  describe(`RunRepository contract — ${name}`, () => {
    let dir: string;
    let h: RepositoryHarness;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "run-repo-contract-"));
      h = factory(dir);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const start = (
      over: Partial<Parameters<RunRepository["startRun"]>[0]> = {},
    ) =>
      h.repo.startRun({
        taskId: `task-${Math.random().toString(36).slice(2)}`,
        recipeName: "demo",
        // "cron" not "manual": RunTrigger is cron | webhook | recipe. A manual
        // run is not a distinct trigger kind in this model.
        trigger: "cron",
        createdAt: 1_000,
        ...over,
      });

    const finish = (seq: number, over: Record<string, unknown> = {}) =>
      h.repo.completeRun(seq, {
        status: "done",
        doneAt: 2_000,
        durationMs: 1_000,
        stepResults: [step("s1")],
        ...over,
      });

    it("a started run is visible as running before it completes", () => {
      const seq = start({ taskId: "t-running" });
      const run = h.repo.getBySeq(seq);
      expect(run?.status).toBe("running");
      expect(run?.taskId).toBe("t-running");
    });

    it("completeRun makes the run terminal and keeps its steps", () => {
      const seq = start();
      finish(seq, { stepResults: [step("a"), step("b")] });
      const run = h.repo.getBySeq(seq);
      expect(run?.status).toBe("done");
      expect(run?.stepResults?.map((s) => s.id)).toEqual(["a", "b"]);
    });

    /**
     * #1340. Steps must be durable AS THEY HAPPEN, not at completion — a run
     * whose process dies mid-flight previously recorded none of the work it had
     * already done.
     *
     * `ownerPid: -1` marks the run as owned by a process that is provably gone,
     * which is the condition recovery is gated on (`isProcessAlive`). Without
     * it the run's owner is THIS live process, recovery correctly declines to
     * touch it, and the assertion below fails for a reason that has nothing to
     * do with durability. The first draft of this test made exactly that
     * mistake and read as a JSONL defect.
     *
     * Asserted through `reopen()`: an in-memory list would satisfy a
     * same-instance read while still losing everything on a crash.
     */
    it("in-flight steps survive a dead owner without completeRun (#1340)", () => {
      const seq = start({ taskId: "t-inflight", ownerPid: -1 });
      h.repo.updateRunSteps(seq, [step("early-1"), step("early-2")]);

      const seen = h
        .reopen()
        .query({ limit: 50 })
        .find((r) => r.taskId === "t-inflight");
      expect(seen, "the run itself must be durable").toBeTruthy();
      expect(
        seen?.stepResults?.map((s) => s.id),
        "work that already happened must not be erased by the interruption",
      ).toEqual(["early-1", "early-2"]);
    });

    /**
     * The scope boundary of the guarantee above, asserted so it cannot be
     * widened by accident. Reversible steps are NOT persisted mid-flight —
     * `runs.jsonl`'s byte cap is what starved the trust ledger, and paying it
     * for steps that carry no trust evidence would buy durability with
     * retention. A future store that "helpfully" persisted everything would
     * reintroduce that trade silently.
     */
    it("reversible in-flight steps are deliberately NOT persisted", () => {
      const seq = start({ taskId: "t-reversible", ownerPid: -1 });
      h.repo.updateRunSteps(seq, [step("rev-1", "ok", "file.write")]);

      const seen = h
        .reopen()
        .query({ limit: 50 })
        .find((r) => r.taskId === "t-reversible");
      expect(seen?.stepResults ?? []).toHaveLength(0);
    });

    /**
     * The other half of the same rule, and the one #1341 got wrong: a run whose
     * owner is ALIVE must be left alone. A reader that "recovers" a live run
     * rewrites its history, which is how a successful run came to be recorded
     * as `interrupted, steps: 0`.
     */
    it("a live owner's in-flight run is not swept by another instance (#1341)", () => {
      const seq = start({ taskId: "t-live" }); // ownerPid defaults to this process
      h.repo.updateRunSteps(seq, [step("in-progress")]);

      const seen = h
        .reopen()
        .query({ limit: 50 })
        .find((r) => r.taskId === "t-live");
      expect(seen?.status, "a live run must stay running").toBe("running");
    });

    it("a completed run is visible to a second instance (durability)", () => {
      const seq = start({ taskId: "t-durable" });
      finish(seq);
      const seen = h
        .reopen()
        .query({ limit: 50 })
        .find((r) => r.taskId === "t-durable");
      expect(seen?.status).toBe("done");
    });

    it("query filters by recipe", () => {
      finish(start({ recipeName: "alpha" }));
      finish(start({ recipeName: "beta" }));
      const names = h.repo.query({ recipe: "alpha" }).map((r) => r.recipeName);
      expect(names).toEqual(["alpha"]);
    });

    it("query filters by status", () => {
      finish(start(), { status: "error", errorMessage: "boom" });
      finish(start());
      expect(h.repo.query({ status: "error" })).toHaveLength(1);
      expect(h.repo.query({ status: "done" })).toHaveLength(1);
    });

    it("query respects limit and returns newest first", () => {
      finish(start({ recipeName: "r1", createdAt: 1 }));
      finish(start({ recipeName: "r2", createdAt: 2 }));
      finish(start({ recipeName: "r3", createdAt: 3 }));
      const got = h.repo.query({ limit: 2 });
      expect(got).toHaveLength(2);
      expect(got[0]?.recipeName).toBe("r3");
    });

    it("query filters by since (createdAt lower bound)", () => {
      finish(start({ createdAt: 100, recipeName: "old" }));
      finish(start({ createdAt: 900, recipeName: "new" }));
      const names = h.repo.query({ since: 500 }).map((r) => r.recipeName);
      expect(names).toEqual(["new"]);
    });

    it("query filters by manualRunId, yielding every retry of one attempt", () => {
      finish(start({ manualRunId: "attempt-A" }));
      finish(start({ manualRunId: "attempt-A" }));
      finish(start({ manualRunId: "attempt-B" }));
      expect(h.repo.query({ manualRunId: "attempt-A" })).toHaveLength(2);
    });

    it("getChildSeqs finds runs by parentSeq", () => {
      const parent = start({ recipeName: "parent" });
      finish(parent);
      const child = start({ recipeName: "child", parentSeq: parent });
      finish(child);
      expect(h.repo.getChildSeqs(parent)).toContain(child);
    });

    it("getBySeq returns null for an unknown seq", () => {
      expect(h.repo.getBySeq(999_999)).toBeNull();
    });

    it("size reflects retained runs", () => {
      expect(h.repo.size()).toBe(0);
      finish(start());
      finish(start());
      expect(h.repo.size()).toBe(2);
    });
  });
}
