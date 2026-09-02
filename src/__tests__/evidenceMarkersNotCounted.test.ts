/**
 * ADR-0027 marker rows (`chain-start`, `rotation`) live in the same file as
 * the data and are not evidence. `patchwork evidence` reports DENOMINATORS,
 * so counting a marker inflates every "N of M rows carry a run id" it prints —
 * by exactly the number of chained ledgers, silently, once chains exist.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceCoverage } from "../evidenceCoverage.js";
import { evidenceRelationships } from "../evidenceRelationships.js";
import { appendChained } from "../ledgerChain.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "evidence-markers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("marker rows are not evidence", () => {
  it("evidenceCoverage counts data rows only, on a chained file with a rotation", () => {
    const f = path.join(dir, "boundary_receipts.jsonl");
    writeFileSync(f, '{"seq":1,"at":1,"decision":"ALLOW"}\n');
    const opts = { maxBytes: 400, rotateTarget: 250 };
    for (let i = 2; i <= 12; i++) {
      appendChained(
        f,
        { seq: i, at: i, decision: "ALLOW", correlationId: `run-${i}` },
        opts,
      );
    }
    const led = evidenceCoverage(dir).ledgers.find(
      (l) => l.file === "boundary_receipts.jsonl",
    );
    expect(led).toBeDefined();
    // Every counted row is a data row: rows === joinable + the unjoinable legacy
    // row that survived, and never more than the data rows written.
    expect(led?.corrupt).toBe(0);
    expect(led?.rows).toBe(led?.joinable);
  });

  it("evidenceRelationships ignores markers as well", () => {
    const f = path.join(dir, "worker_gate_decisions.jsonl");
    appendChained(f, {
      seq: 1,
      rv: 3,
      workerId: "w",
      toolName: "t",
      action: "allow",
      ruleId: "allow.reversible",
      correlationId: "run-1",
    });
    const rel = evidenceRelationships(dir).relationships.find(
      (r) => r.name === "gate decision → run",
    );
    // A marker carries no rv and would be tallied as a LEGACY decision — one
    // phantom legacy row per chained ledger, in the report whose whole job is
    // to say how many legacy rows there are.
    expect(rel?.legacy).toBe(0);
    expect((rel?.connected ?? 0) + (rel?.unresolved ?? 0)).toBe(1);
  });
});
