/**
 * Relationship coverage — the four rules the live ledgers forced.
 *
 * Each of these was a wrong answer the flat "does this row have a
 * correlationId?" reading gave on real data, so each is pinned:
 *
 *  1. `runs.jsonl` is an EVENT log. 974 rows resolved to 505 runs on the
 *     reference machine — a denominator over rows double-counts healthy runs.
 *  2. An approval from an MCP client session never belonged to a run. Six such
 *     rows read as broken until the source is consulted.
 *  3. A `privacy_shadow` row from the orchestrator path is a task dispatch, not
 *     a recipe step. Same shape, same wrong answer.
 *  4. An approval decision reaches its run THROUGH its request. Scoring
 *     decision rows for a run id directly marks every one of them broken.
 *
 * And one distinction that is not a rule but a doctrine: `unresolved` is not
 * `defect`. "The writer never wrote a link" and "the link names a target that
 * is gone" need different remedies, and folding them together is what makes an
 * integrity number that nobody can act on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceRelationships } from "../evidenceRelationships.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-evidence-rel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(file: string, rows: unknown[]): void {
  writeFileSync(
    path.join(dir, file),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}
const rel = (name: string) => {
  const r = evidenceRelationships(dir).relationships.find(
    (x) => x.name === name,
  );
  if (!r) throw new Error(`no relationship named ${name}`);
  return r;
};

describe("runs are an event log, not a table", () => {
  it("collapses repeated rows for one taskId to a single run", () => {
    write("runs.jsonl", [
      { taskId: "yaml:r:1", status: "running" },
      { taskId: "yaml:r:1", status: "done" },
      { taskId: "yaml:r:2", status: "running" },
      { taskId: "yaml:r:2", status: "error" },
    ]);
    const r = evidenceRelationships(dir);
    expect(r.runRows).toBe(4);
    expect(r.distinctRuns).toBe(2);
  });

  it("reads the rotation archive alongside the live file", () => {
    // A run can rotate out while evidence naming it is still current; ignoring
    // the archive would report a healthy join as unresolved because the log grew.
    write("runs.jsonl", [{ taskId: "yaml:new:1", status: "done" }]);
    write("runs.jsonl.1", [{ taskId: "yaml:old:1", status: "done" }]);
    write("boundary_receipts.jsonl", [
      { rv: 1, correlationId: "yaml:old:1", decision: "ALLOW" },
    ]);
    expect(rel("boundary receipt → run").connected).toBe(1);
    expect(rel("boundary receipt → run").unresolved).toBe(0);
  });
});

describe("expectation is a property of the SOURCE, not the row shape", () => {
  it("an MCP client-session approval is not-applicable, not a defect", () => {
    write("runs.jsonl", [{ taskId: "yaml:r:1", status: "done" }]);
    write("approval_log.jsonl", [
      // client session — never belonged to a run
      { kind: "request", callId: "a", rv: 1, sessionId: "7c7c272a-6946" },
      // recipe session — a run IS expected
      {
        kind: "request",
        callId: "b",
        rv: 1,
        sessionId: "recipe",
        correlationId: "yaml:r:1",
      },
    ]);
    const r = rel("approval request → run");
    expect(r.notApplicable).toBe(1);
    expect(r.connected).toBe(1);
    expect(r.defect).toBe(0);
  });

  it("a recipe-session approval WITHOUT a run reference IS a defect", () => {
    write("runs.jsonl", [{ taskId: "yaml:r:1", status: "done" }]);
    write("approval_log.jsonl", [
      { kind: "request", callId: "b", rv: 1, sessionId: "recipe" },
    ]);
    expect(rel("approval request → run").defect).toBe(1);
  });

  it("an orchestrator privacy-shadow row is not-applicable", () => {
    // The orchestrator dispatch path has no recipe run by construction;
    // `recipeName` is the discriminator the recipe path always sets.
    write("runs.jsonl", [{ taskId: "yaml:r:1", status: "done" }]);
    write("privacy_shadow.jsonl", [
      { rv: 1, decision: "ALLOW" },
      { rv: 1, decision: "ALLOW", recipeName: "r", correlationId: "yaml:r:1" },
    ]);
    const r = rel("privacy shadow → run");
    expect(r.notApplicable).toBe(1);
    expect(r.connected).toBe(1);
  });
});

describe("approvals are a two-hop traversal", () => {
  it("scores a decision by its parent request, not by a run id it never carries", () => {
    write("runs.jsonl", [{ taskId: "yaml:r:1", status: "done" }]);
    write("approval_log.jsonl", [
      {
        kind: "request",
        callId: "a",
        rv: 1,
        sessionId: "recipe",
        correlationId: "yaml:r:1",
      },
      { kind: "decision", callId: "a", decision: "approved" },
      { kind: "attribution", callId: "a", actor: { id: "ada", kind: "human" } },
    ]);
    expect(rel("approval decision → request").connected).toBe(1);
    expect(rel("approval attribution → request").connected).toBe(1);
    expect(rel("approval decision → request").defect).toBe(0);
  });

  it("an orphan decision is unresolved — its chain is broken", () => {
    write("runs.jsonl", []);
    write("approval_log.jsonl", [
      { kind: "decision", callId: "ghost", decision: "approved" },
    ]);
    expect(rel("approval decision → request").unresolved).toBe(1);
  });
});

describe("integrity excludes what was never owed", () => {
  it("legacy and not-applicable stay out of the denominator", () => {
    write("runs.jsonl", [{ taskId: "yaml:r:1", status: "done" }]);
    write("worker_gate_decisions.jsonl", [
      { correlationId: "yaml:r:1", rv: 1, ruleId: "allow.reversible" }, // connected
      { toolName: "old" }, // legacy: predates rv
      { toolName: "old2" }, // legacy
    ]);
    const r = rel("gate decision → run");
    expect(r.connected).toBe(1);
    expect(r.legacy).toBe(2);
    // 1 / (1 + 0 + 0) — history must not make a healthy system look broken
    expect(r.integrity).toBe(1);
  });

  it("separates unresolved from defect rather than folding them together", () => {
    write("runs.jsonl", [{ taskId: "yaml:present:1", status: "done" }]);
    write("worker_gate_decisions.jsonl", [
      { rv: 1, correlationId: "yaml:present:1" }, // connected
      { rv: 1, correlationId: "yaml:gone:1" }, // unresolved — target missing
      { rv: 1 }, // defect — never written
    ]);
    const r = rel("gate decision → run");
    expect(r.connected).toBe(1);
    expect(r.unresolved).toBe(1);
    expect(r.defect).toBe(1);
    expect(r.integrity).toBeCloseTo(1 / 3);
  });

  it("reports null integrity when nothing was expected at all", () => {
    write("runs.jsonl", []);
    write("worker_gate_decisions.jsonl", [{ toolName: "legacy-only" }]);
    expect(rel("gate decision → run").integrity).toBeNull();
  });
});
