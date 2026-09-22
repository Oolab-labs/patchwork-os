/**
 * ADR-0025 — `approval_log.jsonl` joins to the run that produced it.
 *
 * Measured 2026-08-31 on the reference deployment: 0 of 215 rows carried any
 * run reference, so no run in the entire history could be assembled into an
 * answer to "who approved this, and under what rule". That is the question an
 * outside party asks first, which is why this ledger was named the next stamp
 * rather than merely the next one in a list.
 *
 * ## Why not the field that was already there
 *
 * `ApprovalRequestEvent` declared `runSeq?: number` and supplied it ZERO times
 * in 105 request rows — declared, never written, exactly the shape `stepId`
 * had on `boundary_receipts.jsonl` before it was removed rather than wired.
 * `approvalQueue.ts` carried an explicit instruction not to populate it: `seq`
 * is a per-instance counter over a file several bridges write and it collides
 * (255 distinct across 272 live gate rows), so an approval joined on it lands
 * on an arbitrary one of the colliding runs. It is retired here, not filled.
 *
 * ## Why absence is a STATE on this ledger and a DEFECT on the gate ledger
 *
 * `WorkerGateDecisionRecord` says a missing `correlationId` at `rv >= 1` is a
 * writer defect, because every gate decision happens inside a run. That is
 * true there and false here. Four paths reach `queue.request`: two carry a run
 * (the tier gate and the worker gate, both of which receive `runTaskId` on
 * `ApprovalRequestInput`), and two are MCP tool calls from a client session
 * that legitimately have no run at all. Encoding this ledger's absence as a
 * defect would assert a run existed for approvals where none did — the exact
 * collapse of two different absences ADR-0025 exists to prevent.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueApprovalWithDispatch } from "../approvalHttp.js";
import { APPROVAL_LOG_RV } from "../approvalPersistence.js";
import { ApprovalQueue } from "../approvalQueue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-corr-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  const file = path.join(dir, "approval_log.jsonl");
  return (
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      // ADR-0027 marker rows (`chain-start`, `rotation`) live in the same
      // file and carry `kind` and no data fields; skipped the way every
      // production loader skips them.
      .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation")
  );
}

function requestRows(): Array<Record<string, unknown>> {
  return rows().filter((r) => r.kind === "request");
}

describe("approval log carries the run it belongs to", () => {
  it("stamps correlationId from the caller onto the durable request row", () => {
    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    queue.request({
      toolName: "github.create_issue",
      params: {},
      tier: "high",
      correlationId: "yaml:some-recipe:1756600000000",
    });

    const [req] = requestRows();
    expect(req?.correlationId).toBe("yaml:some-recipe:1756600000000");
  });

  it("forwards correlationId through the dispatch helper the tier gate uses", () => {
    // The tier gate does NOT call queue.request directly — it goes through
    // `enqueueApprovalWithDispatch`, which destructures `request` and rebuilds
    // the object it passes on. A field added to the type but not to that
    // rebuild is silently dropped on the more common of the two run-bearing
    // paths, and the ledger looks half-stamped for no visible reason.
    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    enqueueApprovalWithDispatch(
      { queue },
      {
        toolName: "git.push",
        params: {},
        tier: "high",
        riskSignals: [],
        sessionId: "recipe",
        correlationId: "yaml:tier-gated:1756600000001",
      },
    );

    const [req] = requestRows();
    expect(req?.correlationId).toBe("yaml:tier-gated:1756600000001");
  });

  it("stamps the schema sentinel on every request row it writes", () => {
    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    queue.request({ toolName: "t", params: {}, tier: "low" });
    expect(requestRows()[0]?.rv).toBe(APPROVAL_LOG_RV);
  });

  it("omits correlationId entirely when the approval had no run", () => {
    // An MCP tool call from a client session. Absence must stay absence: not
    // null, not an empty string, not a sentinel. A reader distinguishes "this
    // approval had no run" from "an older writer did not record one" by `rv`,
    // which is the whole reason the sentinel is written first.
    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    queue.request({ toolName: "readFile", params: {}, tier: "low" });

    const req = requestRows()[0];
    expect(req).toBeDefined();
    expect(Object.hasOwn(req as object, "correlationId")).toBe(false);
    expect(req?.rv).toBe(APPROVAL_LOG_RV);
  });

  it("survives the restore round-trip", () => {
    // `restore` rebuilds a PendingApproval by enumerating fields explicitly —
    // the same shape that dropped two fields on read in #1517. A correlation
    // id that reaches disk and is lost on restart leaves every restored entry
    // unjoinable, which is precisely the population an auditor asks about.
    const first = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    first.request({
      toolName: "github.create_issue",
      params: {},
      tier: "high",
      correlationId: "yaml:restored:1756600000002",
    });

    const second = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    const restored = second.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.correlationId).toBe("yaml:restored:1756600000002");
  });

  it("never writes the retired runSeq field", () => {
    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    queue.request({
      toolName: "t",
      params: {},
      tier: "low",
      correlationId: "yaml:r:1",
    });
    for (const row of rows()) {
      expect(Object.hasOwn(row, "runSeq")).toBe(false);
    }
  });
});
