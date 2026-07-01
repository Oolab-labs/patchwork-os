import { describe, expect, it } from "vitest";
import {
  formatGateDecision,
  formatGateDecisionHistory,
  type GateDecisionRecord,
} from "../workerGateDecisionLog.js";

function rec(over: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    seq: 1,
    decidedAt: Date.UTC(2026, 5, 30, 12, 0, 0),
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

describe("formatGateDecision", () => {
  it("renders the core fields as plain-English prose", () => {
    const out = formatGateDecision(rec());
    expect(out).toContain("w1 → githubCreateIssue");
    expect(out).toContain("issue:compensable:high");
    expect(out).toContain("GATED (asked for approval)");
    expect(out).toContain("Earned trust level: L0 (autonomy ceiling L4)");
    expect(out).toContain("Effective level used for this decision: L0");
    expect(out).toContain("gated for approval");
    expect(out).toContain("Policy: worker-ramp-v0");
  });

  it("renders 'allow' decisions distinctly from 'gate'", () => {
    const out = formatGateDecision(
      rec({
        action: "allow",
        effectiveLevel: 2,
        earnedLevel: 2,
        reason: "earned autonomy",
      }),
    );
    expect(out).toContain("ALLOWED");
    expect(out).not.toContain("GATED");
  });

  it("includes context-risk fields only when present", () => {
    const withoutContext = formatGateDecision(rec());
    expect(withoutContext).not.toContain("Situational risk ceiling");

    const withContext = formatGateDecision(
      rec({
        contextCeiling: 1,
        contextRiskScore: 0.82,
        contextRiskReasons: ["huge uncommitted diff", "on trunk"],
      }),
    );
    expect(withContext).toContain(
      "Situational risk ceiling: L1 (risk score 0.82)",
    );
    expect(withContext).toContain("huge uncommitted diff, on trunk");
  });

  it("marks not-owned classes explicitly", () => {
    const out = formatGateDecision(rec({ owned: false }));
    expect(out).toContain("Owned by this worker: no");
  });
});

describe("formatGateDecisionHistory", () => {
  it("joins multiple records with a blank line between entries", () => {
    const out = formatGateDecisionHistory([
      rec({ seq: 2, toolName: "gitPush" }),
      rec({ seq: 1, toolName: "githubCreateIssue" }),
    ]);
    expect(out).toContain("gitPush");
    expect(out).toContain("githubCreateIssue");
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("renders an empty string for no records", () => {
    expect(formatGateDecisionHistory([])).toBe("");
  });
});
