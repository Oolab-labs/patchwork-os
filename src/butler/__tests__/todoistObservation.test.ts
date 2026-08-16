/**
 * The Todoist observation channel — the first real input to the Butler shadow
 * ledger, which was empty because nothing could observe anything.
 *
 * The arithmetic is trivial. What these tests exist for is the failure
 * mapping, where the two ways to be wrong are both harms and are NOT
 * symmetric:
 *
 *   - reading an API failure as `deleted` manufactures a NEGATIVE against a
 *     worker that did nothing wrong;
 *   - reading an API failure as "observed but open" lets the 14-day staleness
 *     horizon turn an outage into that same negative, with a delay on it.
 *
 * Only HTTP 404 means deleted. Everything else yields NO observation — no
 * `stateObserved`, no `createdAt` — so the grader answers `not-observed` and
 * the fold withholds.
 */

import { describe, expect, it } from "vitest";

import { gradeErrandOutcome } from "../errandOutcomeGrader.js";
import { observeTodoistErrands } from "../todoistObservation.js";

type Result = Awaited<
  ReturnType<
    import("../../connectors/todoist.js").TodoistConnector["observeTask"]
  >
>;

/** Connector double keyed by task id. */
function connector(byId: Record<string, Result | "throw">) {
  return {
    observeTask: async (id: string) => {
      const r = byId[id];
      if (r === "throw") throw new Error("boom");
      if (!r) throw new Error(`unexpected id ${id}`);
      return r;
    },
  };
}

const NOW = 1_800_000_000_000;

describe("only a 404 means deleted", () => {
  it("maps a completed task to a positive act", async () => {
    const run = await observeTodoistErrands(
      connector({
        "1": { kind: "observed", completed: true, createdAt: NOW - 1000 },
      }),
      [{ taskId: "1", ref: "todoist.create_task:1", recipe: "errands" }],
    );
    expect(run.unavailable).toEqual([]);
    expect(run.observations[0]).toMatchObject({
      ref: "todoist.create_task:1",
      completed: true,
      recipe: "errands",
      stateObserved: true,
    });
    expect(gradeErrandOutcome(run.observations[0], { now: NOW })).toEqual({
      disposition: "confirmed",
      reason: "completed",
    });
  });

  it("maps a 404 to deleted", async () => {
    const run = await observeTodoistErrands(
      connector({ "2": { kind: "deleted" } }),
      [{ taskId: "2", ref: "todoist.create_task:2" }],
    );
    expect(run.observations[0]).toMatchObject({ deleted: true });
    expect(gradeErrandOutcome(run.observations[0], { now: NOW })).toEqual({
      disposition: "junk",
      reason: "deleted",
    });
  });

  it("an open task IS an observation, so staleness may apply", async () => {
    const run = await observeTodoistErrands(
      connector({
        "3": {
          kind: "observed",
          completed: false,
          createdAt: NOW - 60 * 24 * 60 * 60 * 1000,
        },
      }),
      [{ taskId: "3", ref: "todoist.create_task:3" }],
    );
    expect(run.observations[0]?.stateObserved).toBe(true);
    // 60 days open, and we looked. This is the case the horizon exists for.
    expect(gradeErrandOutcome(run.observations[0], { now: NOW })).toEqual({
      disposition: "junk",
      reason: "stale-unactioned",
    });
  });
});

describe("an API failure is never a verdict", () => {
  // Exhaustive over the codes `observeTask` can return, because the harm is
  // silent: a mapping that quietly treats one of these as an observation
  // produces a negative nobody can trace back to an outage.
  for (const reason of [
    "auth_expired",
    "permission_denied",
    "rate_limited",
    "provider_error",
    "network_error",
  ]) {
    it(`${reason} produces no observation at all`, async () => {
      const run = await observeTodoistErrands(
        connector({ "4": { kind: "unavailable", reason } }),
        [{ taskId: "4", ref: "todoist.create_task:4" }],
      );
      expect(run.observations).toEqual([]);
      expect(run.unavailable).toEqual([
        { ref: "todoist.create_task:4", reason },
      ]);
    });
  }

  it("a thrown connector error is also not a verdict", async () => {
    const run = await observeTodoistErrands(connector({ "5": "throw" }), [
      { taskId: "5", ref: "todoist.create_task:5" },
    ]);
    expect(run.observations).toEqual([]);
    expect(run.unavailable[0]?.ref).toBe("todoist.create_task:5");
  });

  it("an unreachable API cannot age into a negative", async () => {
    // The delayed form of the same harm. If a failure were recorded as
    // "observed but open", this ancient errand would grade `junk` — an outage
    // converted into evidence against a worker, 14 days later.
    const run = await observeTodoistErrands(
      connector({ "6": { kind: "unavailable", reason: "network_error" } }),
      [{ taskId: "6", ref: "todoist.create_task:6" }],
    );
    expect(run.observations).toEqual([]);
    // And if a caller graded the ref anyway with no observation, it withholds.
    expect(
      gradeErrandOutcome(
        { createdAt: NOW - 365 * 24 * 60 * 60 * 1000 },
        { now: NOW },
      ),
    ).toEqual({ disposition: "unknown", reason: "not-observed" });
  });
});

describe("mixed batches", () => {
  it("reports failures alongside successes rather than dropping either", async () => {
    const run = await observeTodoistErrands(
      connector({
        a: { kind: "observed", completed: true, createdAt: NOW },
        b: { kind: "unavailable", reason: "rate_limited" },
        c: { kind: "deleted" },
      }),
      [
        { taskId: "a", ref: "t:a" },
        { taskId: "b", ref: "t:b" },
        { taskId: "c", ref: "t:c" },
      ],
    );
    expect(run.observations.map((o) => o.ref)).toEqual(["t:a", "t:c"]);
    expect(run.unavailable).toEqual([{ ref: "t:b", reason: "rate_limited" }]);
    // A channel that silently skipped `b` would be indistinguishable from one
    // with nothing to do.
    expect(run.observations.length + run.unavailable.length).toBe(3);
  });
});
