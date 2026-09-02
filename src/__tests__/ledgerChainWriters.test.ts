/**
 * ADR-0027 — the two production writers this slice lands on, verified through
 * the real verifier rather than through their own return values.
 *
 * `boundary_receipts.jsonl` had no lock and no rotation; `worker_gate_decisions
 * .jsonl` had both. Each is seeded with a LEGACY prefix (rows written before
 * the chain existed, in the old shape) so the test also proves the migration
 * boundary: legacy bytes untouched, committed to, and the writer's first new
 * row chained after them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../ledgerChain.js";
import {
  BOUNDARY_RECORD_VERSION,
  BoundaryReceiptLog,
} from "../privacy/boundaryReceiptLog.js";
import { summariseBoundaryReceipts } from "../privacy/boundaryReceipts.js";
import {
  GATE_RECORD_VERSION,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "chain-writers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dataRows = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");

describe("boundary receipts", () => {
  it("chains after a legacy prefix, and the receipt reader carries iseq/prev", () => {
    const file = path.join(dir, "boundary_receipts.jsonl");
    const legacy =
      '{"seq":1,"at":1,"rv":1,"decision":"ALLOW","classification":"internal","destinationId":"d","destinationType":"local","reason":"old"}\n';
    writeFileSync(file, legacy);
    const log = new BoundaryReceiptLog({ dir });
    log.record({
      decision: "ALLOW",
      classification: "internal",
      destinationId: "d",
      destinationType: "local",
      reason: "new",
    });
    expect(readFileSync(file, "utf-8").startsWith(legacy)).toBe(true);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    expect(v.chainedRows).toBe(1);
    const row = dataRows(file).at(-1);
    expect(row).toMatchObject({ rv: BOUNDARY_RECORD_VERSION, iseq: 1 });
    // The explicit-field reader must not drop the new fields (#1517's trap).
    const recent = summariseBoundaryReceipts({ dir, recentLimit: 1 }).recent[0];
    expect(recent).toMatchObject({ iseq: 1 });
    expect(typeof recent?.prev).toBe("string");
  });
});

describe("gate decisions", () => {
  const input = (i: number) => ({
    recipeName: "r",
    workerId: "w",
    toolName: "t",
    action: "allow" as const,
    classKey: "x:reversible:low",
    domain: "x",
    owned: true,
    blastTier: "low" as const,
    reversibility: "reversible" as const,
    earnedLevel: 0,
    autonomyCeiling: 4,
    effectiveLevel: 0,
    reason: `row ${i} ${"p".repeat(40)}`,
    gatePolicyVersion: "worker-ramp-v2",
  });

  it("chains after a legacy prefix and stays readable", () => {
    const file = path.join(dir, "worker_gate_decisions.jsonl");
    writeFileSync(
      file,
      '{"seq":1,"decidedAt":1,"workerId":"w","toolName":"t","action":"gate","classKey":"k","reason":"old"}\n',
    );
    const log = new WorkerGateDecisionLog({ dir });
    log.record(input(1));
    log.record(input(2));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.chainedRows).toBe(2);
    expect(dataRows(file).at(-1)).toMatchObject({
      rv: GATE_RECORD_VERSION,
      iseq: 2,
    });
    // A fresh reader sees the legacy row and both new ones, and no marker.
    expect(new WorkerGateDecisionLog({ dir }).query({}).length).toBe(3);
  });

  it("rotation leaves a verifiable chain with an explicit marker", () => {
    const file = path.join(dir, "worker_gate_decisions.jsonl");
    const warnings: string[] = [];
    const log = new WorkerGateDecisionLog({
      dir,
      maxPersistBytes: 4_000,
      logger: {
        warn: (m) => {
          warnings.push(m);
        },
      },
    });
    for (let i = 1; i <= 60; i++) log.record(input(i));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.rotations).toBe(1);
    expect(v.droppedByRotation).toBeGreaterThan(0);
    expect(v.chainedRows + v.droppedByRotation).toBe(60);
    expect(warnings.some((w) => /rotate dropped \d+ of \d+/.test(w))).toBe(
      true,
    );
    expect(v.lastIseq).toBe(60);
  });
});
