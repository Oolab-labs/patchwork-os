/**
 * Every declared evidence field survives write → disk → read.
 *
 * ## Why this exists
 *
 * The evidence ledgers are written and read through literals that enumerate
 * every field by hand. That shape is DELIBERATE — a spread would let an
 * unvetted caller field reach disk — but it means a field can exist in the
 * type, be stamped by its producer, and be dropped on the way past by a copy
 * site nobody remembered to update. Nothing fails. The field is simply absent
 * from the ledger forever, and absence is exactly what these ledgers treat as
 * meaningful.
 *
 * That is not hypothetical and it is not rare. Known instances:
 *
 *  - `workspaceId` — stamped on every gate decision, never copied by
 *    `record()`; 0 of 272 live rows carried one.
 *  - `correlationId` + `stepId` on the boundary receipts (#1517), dropped by
 *    `view()` on READ.
 *  - `correlationId` on approvals — dropped twice in one change, by the
 *    restore path AND by `list()`.
 *  - `ruleId` — dropped by `record()`, whose own comment already documented
 *    this trap and named the two victims above it.
 *
 * Four fields, three of them found only because someone happened to assert on
 * the FILE rather than on a return value.
 *
 * ## Why the sentinel is typed the way it is
 *
 * Each sentinel is `Required<T>`, so it is a COMPILE error the moment a field
 * is added to the record type and not to the fixture. A normal test fixture
 * would keep passing while silently testing the old shape — which is the same
 * failure mode one level up.
 *
 * Deliberate exclusions are listed explicitly with a reason each, and the test
 * asserts the exclusion set matches exactly. A field cannot join the excluded
 * set by accident; someone has to write down why.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalQueue, type PendingApproval } from "../approvalQueue.js";
import {
  BOUNDARY_RECEIPTS_BASENAME,
  type BoundaryReceiptView,
  summariseBoundaryReceipts,
} from "../privacy/boundaryReceipts.js";
import {
  type RecordGateDecisionInput,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-field-roundtrip-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rowsOf(file: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Assert every key of `sentinel` reached `row`, except the named exclusions —
 * and that the exclusions are exactly the ones declared, so the set cannot
 * quietly grow.
 */
function assertSurvives<T extends object>(
  sentinel: T,
  row: Record<string, unknown>,
  excluded: ReadonlyArray<keyof T>,
  where = "between the writer and the file",
): void {
  const declared = Object.keys(sentinel) as Array<keyof T>;
  const missing = declared.filter(
    (k) => !excluded.includes(k) && !Object.hasOwn(row, k as string),
  );
  expect(missing, `fields dropped ${where}`).toEqual([]);
  // The exclusions must still be REAL fields of the type, not stale names left
  // behind by a rename — otherwise the list silently stops excluding anything.
  for (const k of excluded) {
    expect(
      declared,
      `excluded field "${String(k)}" is not on the type`,
    ).toContain(k);
  }
}

describe("gate decision record — every field reaches disk", () => {
  /** Required<> — adding a field to the input type breaks this literal. */
  const SENTINEL: Required<RecordGateDecisionInput> = {
    recipeName: "sentinel-recipe",
    workerId: "sentinel-worker",
    toolName: "gitPush",
    action: "gate",
    classKey: "vcs-push:compensable:high",
    domain: "vcs-push",
    owned: true,
    blastTier: "high",
    magnitudeBand: "band<=50",
    reversibility: "compensable",
    earnedLevel: 1,
    autonomyCeiling: 4,
    effectiveLevel: 1,
    contextCeiling: 2,
    contextRiskScore: 0.5,
    contextRiskReasons: ["huge uncommitted diff"],
    reason: "compensable + unearned — gated for approval",
    gatePolicyVersion: "worker-ramp-v2",
    correlationId: "yaml:sentinel:1756600000000",
    workspaceId: "ws-sentinel",
    ruleId: "gate.unearned-trust",
    standingPermissionId: "perm-sentinel",
    actor: { id: "ada", kind: "human", displayName: "Ada L" },
  };

  it("persists every declared field", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record(SENTINEL);
    const [row] = rowsOf("worker_gate_decisions.jsonl");
    expect(row).toBeDefined();
    assertSurvives(SENTINEL, row as Record<string, unknown>, []);
  });

  it("stamps the writer-owned fields the input deliberately cannot supply", () => {
    // `rv`, `seq` and `decidedAt` are Omitted from the input ON PURPOSE — a
    // caller-supplied schema version would be a claim by whoever called
    // `record()` rather than by the writer that knows what it stamps.
    const log = new WorkerGateDecisionLog({ dir });
    log.record(SENTINEL);
    const [row] = rowsOf("worker_gate_decisions.jsonl");
    for (const k of ["rv", "seq", "decidedAt"]) {
      expect(Object.hasOwn(row as object, k), `writer must stamp ${k}`).toBe(
        true,
      );
    }
  });
});

describe("approval request — every field reaches disk and comes back", () => {
  type RequestInput = Omit<
    PendingApproval,
    "callId" | "requestedAt" | "expiresAt" | "owned"
  >;

  const SENTINEL: Required<RequestInput> = {
    toolName: "github.create_issue",
    params: { repo: "example/repo" },
    tier: "high",
    sessionId: "recipe",
    summary: "sentinel summary",
    riskSignals: [
      { kind: "destructive_flag", label: "destructive", severity: "high" },
    ],
    personalSignals: [],
    approvalToken: "sentinel-token",
    correlationId: "yaml:sentinel:1756600000001",
    recipeName: "sentinel-recipe",
  };

  /**
   * Fields deliberately NOT persisted, each for a stated reason. Anything not
   * on this list must survive.
   */
  const NOT_PERSISTED: ReadonlyArray<keyof RequestInput> = [
    // A durable log outlives the process and gets grepped and backed up; the
    // approval token is a bearer credential for the phone path.
    "approvalToken",
    // Derived presentation signals recomputed for the live queue, not evidence
    // of what was asked. Persisting them would freeze a UI concern into the
    // audit record.
    "riskSignals",
    "personalSignals",
  ];

  it("persists every declared field except the documented exclusions", () => {
    const q = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    q.request(SENTINEL);
    const [row] = rowsOf("approval_log.jsonl");
    assertSurvives(SENTINEL, row as Record<string, unknown>, NOT_PERSISTED);
  });

  it("survives the restore path AND the list() projection", () => {
    // Two enumerated copies stand between the file and a caller, and BOTH have
    // dropped a field before. A field that reaches disk and dies on the way
    // back is invisible to any test that only reads the file.
    const first = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    first.request(SENTINEL);

    const restored = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    const [entry] = restored.list();
    expect(entry).toBeDefined();

    const survivesRestore = (
      Object.keys(SENTINEL) as Array<keyof RequestInput>
    ).filter((k) => !NOT_PERSISTED.includes(k));
    const lost = survivesRestore.filter(
      (k) => !Object.hasOwn(entry as object, k as string),
    );
    expect(lost, "fields lost between the file and list()").toEqual([]);
  });
});

describe("boundary receipt — every field survives the READ", () => {
  /**
   * The other half of the defect class, and the half that bit hardest: here
   * the field reaches disk correctly and is discarded on the way OUT. #1517
   * was exactly this — a `forbid` decision written correctly and dropped by
   * every reader — and `workspaceId` was thrown away by the last step of its
   * own pipeline the same way.
   *
   * Written as a raw row rather than through a writer on purpose: this guards
   * the reader, so the row must contain every field regardless of whether any
   * current writer happens to emit them all.
   */
  const SENTINEL: Required<BoundaryReceiptView> = {
    seq: 1,
    at: 1756600000000,
    rv: 1,
    correlationId: "yaml:sentinel:1756600000002",
    decision: "DENY",
    classification: "personal",
    categories: ["mailbox"],
    destinationId: "sentinel-destination",
    destinationType: "remote",
    redactCategories: ["mailbox"],
    reason: "sentinel reason",
    recipeName: "sentinel-recipe",
    labelSource: "declared",
    workspaceId: "ws-sentinel",
  };

  it("returns every declared field through the public reader", () => {
    writeFileSync(
      path.join(dir, BOUNDARY_RECEIPTS_BASENAME),
      `${JSON.stringify(SENTINEL)}\n`,
      "utf8",
    );
    const summary = summariseBoundaryReceipts({ dir, recentLimit: 5 });
    const [got] = summary.recent;
    expect(got, "the sentinel row was readable at all").toBeDefined();
    assertSurvives(
      SENTINEL,
      got as unknown as Record<string, unknown>,
      [],
      "between the file and the reader",
    );
  });
});
