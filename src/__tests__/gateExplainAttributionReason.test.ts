/**
 * `gate explain` told the operator the wrong thing about WHY a decision names
 * nobody, and it told it about rows written today.
 *
 * `formatGateDecision` printed one unconditional line for every actor-less row:
 *
 *   Attributed to: not recorded (pre-dates actor attribution)
 *
 * But `recipeOrchestration.ts` stamps an actor ONLY on `allow`, and says so at
 * length: on `gate` "the approving human is not known here", on `forbid`
 * "nobody acted". Those absences are CURRENT POLICY, not history. Measured
 * against the live ledger on 2026-08-25: 272 rows, 47 of them `gate`, and every
 * one of those 47 received the era claim.
 *
 * This is the two-absences collapse the Decision Record's own doctrine exists to
 * prevent — "nobody recorded this" made indistinguishable from "we do not know"
 * — already shipped, in the one surface an operator actually reads. It is worse
 * than an omission: an omitted line invites a question, whereas this line
 * answers it, confidently and wrongly.
 *
 * The fix composes the explanation with `action`. No row's DATA changes; only
 * what the reader is told about it.
 */

import { describe, expect, it } from "vitest";
import type { GateDecisionRecord } from "../workerGateDecisionLog.js";
import { formatGateDecision } from "../workerGateDecisionLog.js";

const base: GateDecisionRecord = {
  seq: 1,
  decidedAt: 1_756_000_000_000,
  recipeName: "example-recipe",
  workerId: "w1",
  toolName: "githubCreateIssue",
  action: "allow",
  classKey: "issue:compensable:low",
  domain: "issue",
  owned: true,
  blastTier: "low",
  reversibility: "compensable",
  earnedLevel: 4,
  autonomyCeiling: 4,
  effectiveLevel: 4,
  reason: "earned",
  gatePolicyVersion: "worker-ramp-v1",
};

const attribution = (r: GateDecisionRecord): string =>
  formatGateDecision(r)
    .split("\n")
    .find((l) => l.includes("Attributed to:")) ?? "";

describe("gate explain does not blame history for a policy absence", () => {
  it("does not claim a GATE row pre-dates attribution", () => {
    // The bug. 47 of 272 live rows hit this branch.
    const line = attribution({ ...base, action: "gate" });
    expect(line).not.toContain("pre-dates");
    expect(line).toMatch(/approv/i);
  });

  it("does not claim a FORBID row pre-dates attribution", () => {
    const line = attribution({ ...base, action: "forbid" });
    expect(line).not.toContain("pre-dates");
    expect(line).toMatch(/nobody acted|policy/i);
  });

  it("still says an actor-less ALLOW was not recorded", () => {
    // The one case where the era claim is defensible: `allow` DOES stamp an
    // actor today, so its absence really does mean nobody recorded it.
    expect(attribution({ ...base, action: "allow" })).toContain("not recorded");
  });

  it("still names a real actor when one is present (control)", () => {
    const line = attribution({
      ...base,
      actor: { id: "w1", kind: "worker", displayName: "Worker One" },
    });
    expect(line).toContain("Worker One");
    expect(line).not.toContain("not recorded");
  });

  it("never synthesises an actor for any action", () => {
    // The absence must stay an absence. ADR-0017 keeps "nobody recorded this"
    // distinguishable from a synthesized "unknown"; explaining the absence must
    // not become inventing a value for it.
    for (const action of ["allow", "gate", "forbid"] as const) {
      const line = attribution({ ...base, action });
      expect(line).not.toMatch(/\bunknown\b/i);
    }
  });
});
