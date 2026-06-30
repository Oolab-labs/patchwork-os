import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RecordGateDecisionInput,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-gate-decisions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rec(
  over: Partial<RecordGateDecisionInput> = {},
): RecordGateDecisionInput {
  return {
    recipeName: "triage",
    workerId: "w1",
    toolName: "githubCreateIssue",
    action: "gate",
    classKey: "issue:compensable:high",
    domain: "issue",
    owned: true,
    blastTier: "high",
    reversibility: "compensable",
    earnedLevel: 0,
    autonomyCeiling: 4,
    effectiveLevel: 0,
    reason: "compensable + unearned (effective L0 < L4) — gated for approval",
    gatePolicyVersion: "worker-ramp-v0",
    ...over,
  };
}

describe("WorkerGateDecisionLog", () => {
  it("records a decision and reads it back with assigned seq + decidedAt", () => {
    const log = new WorkerGateDecisionLog({ dir, now: () => 1234 });
    const r = log.record(rec());
    expect(r.seq).toBe(1);
    expect(r.decidedAt).toBe(1234);
    const [back] = log.query();
    expect(back?.toolName).toBe("githubCreateIssue");
    expect(back?.gatePolicyVersion).toBe("worker-ramp-v0");
  });

  it("persists context-risk inputs only when present", () => {
    const log = new WorkerGateDecisionLog({ dir });
    const withRisk = log.record(
      rec({
        contextCeiling: 0,
        contextRiskScore: 0.9,
        contextRiskReasons: ["huge diff"],
      }),
    );
    expect(withRisk.contextCeiling).toBe(0);
    expect(withRisk.contextRiskScore).toBe(0.9);
    expect(withRisk.contextRiskReasons).toEqual(["huge diff"]);
    const clean = log.record(rec());
    expect(clean).not.toHaveProperty("contextCeiling");
    expect(clean).not.toHaveProperty("contextRiskScore");
  });

  it("filters by workerId / classKey / action / since / after", () => {
    const log = new WorkerGateDecisionLog({ dir, now: () => 100 });
    log.record(rec({ workerId: "w1", action: "gate" }));
    log.record(
      rec({
        workerId: "w2",
        action: "allow",
        classKey: "vcs-push:compensable:high",
      }),
    );
    expect(log.query({ workerId: "w1" })).toHaveLength(1);
    expect(log.query({ action: "allow" })).toHaveLength(1);
    expect(log.query({ classKey: "vcs-push:compensable:high" })).toHaveLength(
      1,
    );
    expect(log.query({ after: 1 })).toHaveLength(1); // seq > 1 → only the 2nd
    expect(log.query({ since: 200 })).toHaveLength(0);
  });

  it("validates required identity fields + a legal action", () => {
    const log = new WorkerGateDecisionLog({ dir });
    expect(() => log.record(rec({ recipeName: "" }))).toThrow(/recipeName/);
    expect(() => log.record(rec({ workerId: "  " }))).toThrow(/workerId/);
    expect(() => log.record(rec({ classKey: "" }))).toThrow(/classKey/);
    expect(() =>
      log.record(rec({ action: "approve" as unknown as "gate" })),
    ).toThrow(/action/);
  });

  it("clips an overlong reason + caps context reasons", () => {
    const log = new WorkerGateDecisionLog({ dir });
    const r = log.record(
      rec({
        reason: "x".repeat(5000),
        contextRiskReasons: Array.from({ length: 50 }, (_, i) => `r${i}`),
      }),
    );
    expect(r.reason.length).toBeLessThanOrEqual(1000);
    expect((r.contextRiskReasons ?? []).length).toBeLessThanOrEqual(16);
  });

  it("survives a process restart (loadExisting from JSONL)", () => {
    const a = new WorkerGateDecisionLog({ dir });
    a.record(rec({ toolName: "gitPush" }));
    a.record(rec({ toolName: "githubMergePR" }));
    // a fresh instance reads the persisted rows
    const b = new WorkerGateDecisionLog({ dir });
    expect(b.size()).toBe(2);
    expect(b.query().map((r) => r.toolName)).toContain("githubMergePR");
    // seq continues monotonically, not reset
    expect(b.record(rec()).seq).toBe(3);
  });
});
