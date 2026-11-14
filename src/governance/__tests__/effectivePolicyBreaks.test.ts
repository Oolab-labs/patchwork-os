/**
 * The per-step policy calculation, one rule at a time.
 *
 * `computeEffectivePolicy` is what both runners consult before every step, so
 * a rule that silently stops applying loosens real decisions. A mutation run
 * (Stryker, 2026-11-14) listed rules that could be removed while the existing
 * suite stayed green; each test below pins one, with a control beside it that
 * shows the same input passes when the rule's condition is absent.
 */

import { describe, expect, it } from "vitest";
import {
  computeEffectivePolicy,
  type EffectivePolicyInput,
  type ToolFacts,
  tierVerdict,
} from "../effectivePolicy.js";
import { resolveProfile } from "../profile.js";

const governed = resolveProfile({ profile: "governed" });
const compatHigh = resolveProfile({ approvalGate: "high" });
const compatAll = resolveProfile({ approvalGate: "all" });

const readTool: ToolFacts = {
  id: "example.read",
  tier: "low",
  isWrite: false,
  tierDeclared: true,
  registered: true,
};
const writeTool = (f: Partial<ToolFacts> = {}): ToolFacts => ({
  id: "example.write",
  namespace: "example",
  tier: "low",
  isWrite: true,
  tierDeclared: true,
  registered: true,
  reversibility: "reversible",
  ...f,
});

function run(over: Partial<EffectivePolicyInput>) {
  return computeEffectivePolicy({
    profile: governed,
    recipe: { name: "example-recipe" },
    trigger: "manual",
    tool: readTool,
    killSwitch: { engaged: false, reason: "released" },
    ...over,
  });
}
const stage = (r: ReturnType<typeof run>, name: string) =>
  r.stages.find((s) => s.stage === name);

describe("tool tier rules", () => {
  it("approvalGate: all asks for an ordinary low-tier read", () => {
    expect(tierVerdict(compatAll, readTool).verdict).toBe("APPROVAL");
    expect(run({ profile: compatAll }).final).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(tierVerdict(compatHigh, readTool).verdict).toBe("ALLOW");
  });

  it("a high-tier tool asks under approvalGate: high", () => {
    expect(tierVerdict(compatHigh, { ...readTool, tier: "high" }).verdict).toBe(
      "APPROVAL",
    );
    expect(
      tierVerdict(compatHigh, { ...readTool, tier: "medium" }).verdict,
    ).toBe("ALLOW");
  });

  it("governed asks for a non-reversible write whatever its tier; a reversible one flows", () => {
    for (const reversibility of ["compensable", "irreversible"] as const) {
      expect(
        tierVerdict(governed, writeTool({ reversibility })).verdict,
        reversibility,
      ).toBe("APPROVAL");
    }
    expect(tierVerdict(governed, writeTool()).verdict).toBe("ALLOW");
  });

  it("governed asks for a write tool whose tier was only inferred, or whose write-ness is unknown", () => {
    expect(
      tierVerdict(
        governed,
        writeTool({ tierDeclared: false, reversibility: undefined }),
      ).verdict,
    ).toBe("APPROVAL");
    expect(
      tierVerdict(
        governed,
        writeTool({ isWrite: undefined, reversibility: undefined }),
      ).verdict,
    ).toBe("APPROVAL");
    expect(
      tierVerdict(governed, writeTool({ reversibility: undefined })).verdict,
    ).toBe("ALLOW");
  });

  it("a contained agent step that widened containment asks; an unwidened one flows", () => {
    const agent: ToolFacts = {
      id: "agent",
      tier: "medium",
      tierDeclared: true,
      registered: true,
      isAgentStep: true,
      agentContained: true,
    };
    expect(
      tierVerdict(governed, { ...agent, agentWidenings: ["Write"] }).verdict,
    ).toBe("APPROVAL");
    expect(
      tierVerdict(governed, { ...agent, agentWidenings: [] }).verdict,
    ).toBe("ALLOW");
    expect(tierVerdict(governed, agent).verdict).toBe("ALLOW");
  });
});

describe("worker authority", () => {
  it("a worker gate with no standing permission requires a human, even for a low-tier read", () => {
    const r = run({ worker: { id: "w1", action: "gate" } });
    expect(stage(r, "tool_tier")?.verdict).toBe("ALLOW");
    expect(r.final).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("only a standing permission converts that gate to flow", () => {
    const r = run({
      worker: { id: "w1", action: "gate", standingPermissionId: "sp-1" },
    });
    expect(stage(r, "standing_permission")?.verdict).toBe("ALLOW");
    expect(r.final).toBe("ALLOW");
  });

  it("a worker forbid refuses, and no approval is consulted", () => {
    const r = run({ worker: { id: "w1", action: "forbid" } });
    expect(r.final).toBe("REFUSED");
    expect(r.consultsApproval).toBe(false);
    expect(run({ worker: { id: "w1", action: "allow" } }).final).toBe("ALLOW");
  });

  it("an owning worker gates an automated run under compat, and a recipe cannot opt out of it", () => {
    for (const recipe of [
      { name: "r" },
      { name: "r", requireApproval: false },
    ]) {
      const r = run({
        profile: compatHigh,
        trigger: "cron",
        recipe,
        worker: { id: "w1", action: "gate" },
      });
      expect(r.consultsApproval, JSON.stringify(recipe)).toBe(true);
      expect(r.final).toBe("HUMAN_APPROVAL_REQUIRED");
    }
    // Control: the same automated run with no worker is not consulted under compat.
    expect(run({ profile: compatHigh, trigger: "cron" }).consultsApproval).toBe(
      false,
    );
  });
});

describe("write acknowledgement", () => {
  it("governed refuses a write the recipe did not declare in allowWrites", () => {
    expect(run({ tool: writeTool() }).final).toBe("REFUSED");
    expect(
      run({ tool: writeTool(), allowWrites: ["example.write"] }).final,
    ).toBe("ALLOW");
    expect(run({ tool: writeTool(), allowWrites: ["example"] }).final).toBe(
      "ALLOW",
    );
  });
});

describe("privacy", () => {
  it("any boundary decision other than ALLOW refuses the step", () => {
    const agent: ToolFacts = {
      id: "agent",
      tier: "medium",
      tierDeclared: true,
      registered: true,
      isAgentStep: true,
      agentContained: true,
    };
    for (const decision of [
      "LOCAL_ONLY",
      "DENY",
      "REQUIRE_APPROVAL",
      "ALLOW_REDACTED",
    ] as const) {
      const r = run({
        tool: agent,
        privacy: {
          classification: "personal",
          destination: "remote",
          decision,
        },
      });
      expect(r.final, decision).toBe("REFUSED");
    }
    expect(
      run({
        tool: agent,
        privacy: {
          classification: "internal",
          destination: "remote",
          decision: "ALLOW",
        },
      }).final,
    ).toBe("ALLOW");
  });
});
