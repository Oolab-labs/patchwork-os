/**
 * `ruleOf` — the same three-way honesty `correlationOf` has, one field over.
 *
 * The distinction that matters: a row written before rules were named is
 * `unversioned`, NOT "no rule applied". A rule DID apply; nobody recorded
 * which. Collapsing those two into one value is the absence-collapse ADR-0025
 * exists to prevent, and it cannot be undone once readers depend on it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATE_RECORD_VERSION,
  ruleOf,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

describe("ruleOf", () => {
  it("reports a pre-rule row as unversioned, never as 'no rule'", () => {
    expect(ruleOf({ rv: 1, correlationId: "t" } as never)).toEqual({
      state: "unversioned",
    });
    expect(ruleOf({} as never)).toEqual({ state: "unversioned" });
  });

  it("names the rule when the row carries one at a version that guarantees it", () => {
    expect(ruleOf({ rv: 2, ruleId: "gate.unearned-trust" } as never)).toEqual({
      state: "named",
      ruleId: "gate.unearned-trust",
    });
  });

  it("reports a WRITER DEFECT when the level guarantees a rule and none is there", () => {
    // Not "unversioned": the row claims rv>=2, which promises a ruleId. A
    // reader must be able to tell a writer bug from an older writer.
    expect(ruleOf({ rv: 2 } as never)).toEqual({ state: "defect", rv: 2 });
    expect(ruleOf({ rv: 2, ruleId: "" } as never)).toEqual({
      state: "defect",
      rv: 2,
    });
  });
});

describe("the durable record carries the rule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-gate-rule-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists ruleId and stamps the version that guarantees it", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record({
      recipeName: "r",
      correlationId: "yaml:r:1",
      workerId: "w",
      toolName: "gitPush",
      action: "gate",
      ruleId: "gate.unearned-trust",
      classKey: "vcs-push:compensable:high",
      domain: "vcs-push",
      owned: true,
      blastTier: "high",
      reversibility: "compensable",
      earnedLevel: 0,
      autonomyCeiling: 4,
      effectiveLevel: 0,
      reason: "compensable + unearned — gated for approval",
      gatePolicyVersion: "worker-ramp-v2",
    } as never);

    const rows = readFileSync(
      path.join(dir, "worker_gate_decisions.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      // ADR-0027 marker rows share the file and are not data rows.
      .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");

    expect(rows).toHaveLength(1);
    expect(rows[0].ruleId).toBe("gate.unearned-trust");
    expect(rows[0].rv).toBe(GATE_RECORD_VERSION);
    expect(ruleOf(rows[0])).toEqual({
      state: "named",
      ruleId: "gate.unearned-trust",
    });
  });

  it("GATE_RECORD_VERSION is at least 2 — the level that promises a rule id", () => {
    // A ratchet: dropping back below 2 would make every new row read as
    // `unversioned` while still carrying a ruleId, which is the quietest
    // possible way to lose the field's meaning.
    expect(GATE_RECORD_VERSION).toBeGreaterThanOrEqual(2);
  });
});
