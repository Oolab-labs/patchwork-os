/**
 * `classifyChecks` — the pure half of scripts/wait-pr-checks.mjs.
 *
 * Exists because of a one-liner that got it wrong on 2026-10-01: an ad-hoc
 * `jq` filter treated a check with `conclusion: ""` as FAILED, when an empty
 * conclusion is what an in-progress or queued check run carries. Four CI
 * cells reported as failures while they were simply still running. The
 * classifier here is the one place that decision lives: an incomplete check
 * is PENDING, never failed, and never passed.
 */
import { describe, expect, it } from "vitest";
import { classifyChecks } from "../wait-pr-checks.mjs";

const run = (name, status, conclusion) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});
const ctx = (context, state) => ({
  __typename: "StatusContext",
  context,
  state,
});

describe("classifyChecks", () => {
  it("an in-progress check run with an empty conclusion is PENDING, not failed", () => {
    const r = classifyChecks([
      run("ci (ubuntu-latest, 22)", "IN_PROGRESS", ""),
    ]);
    expect(r.failed).toEqual([]);
    expect(r.passed).toEqual([]);
    expect(r.pending).toEqual(["ci (ubuntu-latest, 22)"]);
    expect(r.settled).toBe(false);
  });

  it("a queued check run with a null conclusion is PENDING too", () => {
    const r = classifyChecks([run("CodeQL", "QUEUED", null)]);
    expect(r.pending).toEqual(["CodeQL"]);
    expect(r.failed).toEqual([]);
  });

  it("completed + SUCCESS / SKIPPED / NEUTRAL pass; FAILURE / CANCELLED / TIMED_OUT / ACTION_REQUIRED / STALE fail", () => {
    const r = classifyChecks([
      run("a", "COMPLETED", "SUCCESS"),
      run("b", "COMPLETED", "SKIPPED"),
      run("c", "COMPLETED", "NEUTRAL"),
      run("d", "COMPLETED", "FAILURE"),
      run("e", "COMPLETED", "CANCELLED"),
      run("f", "COMPLETED", "TIMED_OUT"),
      run("g", "COMPLETED", "ACTION_REQUIRED"),
      run("h", "COMPLETED", "STALE"),
    ]);
    expect(r.passed).toEqual(["a", "b", "c"]);
    expect(r.failed).toEqual(["d", "e", "f", "g", "h"]);
    expect(r.pending).toEqual([]);
    expect(r.settled).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("a COMPLETED run with an empty conclusion is FAILED — completion without a verdict is not a pass", () => {
    const r = classifyChecks([run("x", "COMPLETED", "")]);
    expect(r.failed).toEqual(["x"]);
  });

  it("legacy StatusContext: PENDING / EXPECTED pending, SUCCESS passes, FAILURE / ERROR fail", () => {
    const r = classifyChecks([
      ctx("CLA acceptance", "PENDING"),
      ctx("expected", "EXPECTED"),
      ctx("ok", "SUCCESS"),
      ctx("bad", "FAILURE"),
      ctx("err", "ERROR"),
    ]);
    expect(r.pending).toEqual(["CLA acceptance", "expected"]);
    expect(r.passed).toEqual(["ok"]);
    expect(r.failed).toEqual(["bad", "err"]);
  });

  it("an empty rollup is NOT settled — checks have not registered yet", () => {
    const r = classifyChecks([]);
    expect(r.settled).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fewer than minChecks items is not settled either (the first poll after PR creation)", () => {
    const r = classifyChecks([run("a", "COMPLETED", "SUCCESS")], {
      minChecks: 5,
    });
    expect(r.settled).toBe(false);
    const r2 = classifyChecks([run("a", "COMPLETED", "SUCCESS")], {
      minChecks: 1,
    });
    expect(r2.settled).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("settled is true only when nothing is pending; ok only when settled and nothing failed", () => {
    const mixed = classifyChecks([
      run("a", "COMPLETED", "SUCCESS"),
      run("b", "IN_PROGRESS", ""),
    ]);
    expect(mixed.settled).toBe(false);
    expect(mixed.ok).toBe(false);
    const green = classifyChecks([
      run("a", "COMPLETED", "SUCCESS"),
      run("b", "COMPLETED", "SUCCESS"),
    ]);
    expect(green.settled).toBe(true);
    expect(green.ok).toBe(true);
  });

  it("an item of unknown shape is reported as pending, not silently dropped", () => {
    const r = classifyChecks([{ __typename: "Something", name: "odd" }]);
    expect(r.pending).toEqual(["odd"]);
  });
});
