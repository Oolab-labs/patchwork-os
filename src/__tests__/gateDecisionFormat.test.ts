import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffGateDecisions,
  formatGateDecision,
  formatGateDecisionDiff,
  formatGateDecisionHistory,
  type GateDecisionRecord,
  WorkerGateDecisionLog,
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

describe("formatGateDecision — forward compatibility (ADR-0017)", () => {
  // These originally used "forbid" as the stand-in for an unrecognised action.
  // `forbid` is now a real action, so they moved to a value that is still
  // unknown — the guard has to test the DEFAULT branch, not a value that has
  // since been implemented.
  const UNKNOWN = "quarantine" as GateDecisionRecord["action"];

  it("does not report an unrecognised action as merely gated", () => {
    // The else-form told an operator the action was awaiting approval when in
    // fact nothing of the sort was true.
    expect(formatGateDecision(rec({ action: UNKNOWN }))).not.toContain(
      "GATED (asked for approval)",
    );
  });

  it("names the unrecognised action and says the reader is out of date", () => {
    const out = formatGateDecision(rec({ action: UNKNOWN }));
    expect(out).toContain("quarantine");
    expect(out.toLowerCase()).toContain("newer");
  });

  it("still renders every other field of a forward record", () => {
    const out = formatGateDecision(rec({ action: UNKNOWN }));
    expect(out).toContain("w1 → githubCreateIssue");
    expect(out).toContain("issue:compensable:high");
    expect(out).toContain("Effective level used for this decision: L0");
  });

  it("renders the three known actions distinctly", () => {
    expect(formatGateDecision(rec({ action: "allow" }))).toContain("ALLOWED");
    expect(formatGateDecision(rec({ action: "gate" }))).toContain(
      "GATED (asked for approval)",
    );
    expect(formatGateDecision(rec({ action: "forbid" }))).toContain(
      "FORBIDDEN (no approval can unlock this)",
    );
  });

  it("never describes a forbidden action as approvable", () => {
    // The whole point of the third state: an operator must not read this and
    // think someone can wave it through.
    const out = formatGateDecision(rec({ action: "forbid" }));
    expect(out).not.toContain("asked for approval");
    expect(out).not.toContain("ALLOWED");
  });
});

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

describe("diffGateDecisions", () => {
  it("reports only the fields that changed, from (older) → to (newer)", () => {
    const older = rec({
      seq: 1,
      action: "gate",
      earnedLevel: 0,
      effectiveLevel: 0,
    });
    const newer = rec({
      seq: 2,
      action: "allow",
      earnedLevel: 2,
      effectiveLevel: 2,
      reason: "earned autonomy (L2) on compensable class — auto-allowed at L2+",
    });
    const diffs = diffGateDecisions(newer, older);
    const byField = Object.fromEntries(diffs.map((d) => [d.field, d]));
    expect(byField.action).toEqual({
      field: "action",
      from: "gate",
      to: "allow",
    });
    expect(byField.earnedLevel).toEqual({
      field: "earnedLevel",
      from: "L0",
      to: "L2",
    });
    expect(byField.effectiveLevel).toEqual({
      field: "effectiveLevel",
      from: "L0",
      to: "L2",
    });
    expect(byField.reason?.to).toContain("auto-allowed");
    // unchanged fields (owned, autonomyCeiling) must not appear
    expect(byField.owned).toBeUndefined();
    expect(byField.autonomyCeiling).toBeUndefined();
  });

  it("returns an empty array for two identical decisions", () => {
    const a = rec({ seq: 1 });
    const b = rec({ seq: 2 });
    expect(diffGateDecisions(b, a)).toEqual([]);
  });

  it("renders contextCeiling appearing/disappearing as a readable transition", () => {
    const older = rec({ seq: 1 });
    const newer = rec({ seq: 2, contextCeiling: 1, contextRiskScore: 0.8 });
    const diffs = diffGateDecisions(newer, older);
    const ctx = diffs.find((d) => d.field === "contextCeiling");
    expect(ctx).toEqual({ field: "contextCeiling", from: "—", to: "L1" });
  });
});

describe("formatGateDecisionDiff", () => {
  it("renders a header identifying both decisions plus one line per change", () => {
    const older = rec({ seq: 1, action: "gate" });
    const newer = rec({ seq: 2, action: "allow" });
    const out = formatGateDecisionDiff(newer, older);
    expect(out).toContain("seq 1");
    expect(out).toContain("seq 2");
    expect(out).toContain("w1");
    expect(out).toContain("issue:compensable:high");
    expect(out).toContain("action: gate → allow");
  });

  it("renders an explicit 'no change' line for identical decisions", () => {
    const a = rec({ seq: 1 });
    const b = rec({ seq: 2 });
    const out = formatGateDecisionDiff(b, a);
    expect(out).toContain("No change — identical decision.");
  });
});

// ── actor attribution (ADR-0017) ────────────────────────────────────────────

describe("formatGateDecision — actor", () => {
  it("names the actor when one is recorded", () => {
    const out = formatGateDecision(
      rec({ actor: { id: "anna", kind: "human", displayName: "Anna Reyes" } }),
    );
    expect(out).toContain("Attributed to: Anna Reyes (anna) — human");
  });

  it("falls back to the id when there is no display name", () => {
    const out = formatGateDecision(
      rec({ actor: { id: "anna", kind: "human" } }),
    );
    expect(out).toContain("Attributed to: anna — human");
  });

  it("says so explicitly when nobody was recorded", () => {
    // Omitting the line entirely would read as "attribution not applicable".
    // The honest signal is that nobody recorded it — which must stay
    // distinguishable from a synthesized "unknown" (ADR-0017: no backfill).
    expect(formatGateDecision(rec())).toContain("not recorded");
  });
});

// ── record() actor validation ───────────────────────────────────────────────

describe("WorkerGateDecisionLog.record — actor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-actor-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({
    recipeName: "triage",
    workerId: "w1",
    toolName: "githubCreateIssue",
    action: "gate" as const,
    classKey: "issue:compensable:high",
    domain: "issue",
    owned: true,
    blastTier: "high",
    reversibility: "compensable" as const,
    earnedLevel: 0,
    autonomyCeiling: 4 as const,
    effectiveLevel: 0,
    reason: "gated",
    gatePolicyVersion: "worker-ramp-v0",
  });

  it("stores an actor and round-trips it through the log", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record({
      ...base(),
      actor: { id: "anna", kind: "human", displayName: "Anna Reyes" },
    });
    expect(log.query()[0]?.actor).toEqual({
      id: "anna",
      kind: "human",
      displayName: "Anna Reyes",
    });
  });

  it("omits the actor entirely when none is supplied", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record(base());
    expect(log.query()[0]).not.toHaveProperty("actor");
  });

  it("drops an actor with a blank id rather than storing a nameless one", () => {
    // A blank id attributes the decision to nobody while LOOKING attributed,
    // which is worse than leaving it absent.
    const log = new WorkerGateDecisionLog({ dir });
    log.record({ ...base(), actor: { id: "   ", kind: "human" } });
    expect(log.query()[0]).not.toHaveProperty("actor");
  });

  it("defaults an unrecognised kind to human rather than inventing a third", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record({
      ...base(),
      actor: { id: "x", kind: "robot" as unknown as "human" },
    });
    expect(log.query()[0]?.actor?.kind).toBe("human");
  });
});
