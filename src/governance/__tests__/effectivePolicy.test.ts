/**
 * Effective policy — pure calculation + PREVIEW == ENFORCEMENT.
 *
 * The second block is the load-bearing one: it runs the real flat runner
 * with a recording approval fn over a matrix of (profile × trigger × tool)
 * and asserts that whether the runner consulted approval, and the verdict it
 * handed the gate, equals what `computeEffectivePolicy` says for the same
 * inputs. A calculation that drifts from the runner fails here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../../recipes/yamlRunner.js";
import "../../recipes/tools/index.js";
import {
  computeEffectivePolicy,
  shouldConsultApproval,
  tierVerdict,
} from "../effectivePolicy.js";
import {
  _resetActiveProfileForTesting,
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  resolveAgentContainment,
  resolveProfile,
} from "../profile.js";
import { toolFactsFor } from "../toolFacts.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "effective-policy-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => _resetActiveProfileForTesting());

const KS_OFF = { engaged: false, reason: "released" };

describe("resolveProfile", () => {
  it("absent or unknown profile is compat and byte-identical to before", () => {
    expect(resolveProfile(undefined).mode).toBe("compat");
    expect(resolveProfile({ profile: "banana" }).mode).toBe("compat");
    expect(resolveProfile({ profile: "banana" }).declared).toBe(false);
    const c = resolveProfile({ approvalGate: "off" });
    expect(c.approvalGate).toBe("off");
    expect(c.gateAutomatedRuns).toBe(false);
    expect(c.killSwitchFailClosed).toBe(false);
    expect(c.pluginPolicy).toBe("open");
    expect(c.unregisteredTools).toBe("skip");
  });
  it("governed raises the gate to high but never lowers an explicit all", () => {
    expect(resolveProfile({ profile: "governed" }).approvalGate).toBe("high");
    expect(
      resolveProfile({ profile: "governed", approvalGate: "off" }).approvalGate,
    ).toBe("high");
    expect(
      resolveProfile({ profile: "governed", approvalGate: "all" }).approvalGate,
    ).toBe("all");
  });
});

describe("resolveAgentContainment", () => {
  it("compat: contained only when the step opts in", () => {
    expect(resolveAgentContainment(COMPAT_PROFILE, undefined).enforced).toBe(
      false,
    );
    expect(
      resolveAgentContainment(COMPAT_PROFILE, { sandbox: true }).enforced,
    ).toBe(true);
  });
  it("governed: contained by default, deny beats allow, widenings recorded", () => {
    const c = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    expect(c.enforced).toBe(true);
    expect(c.allowedTools).toEqual(["Read", "Glob", "Grep", "LS"]);
    expect(c.deniedTools).toEqual(["WebFetch", "WebSearch", "Bash"]);
    expect(c.envAllowlist).toBe(true);
    expect(c.mcpAccess).toBe(false);
    const w = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: ["Bash", "Write"],
      network: true,
    });
    expect(w.allowedTools).not.toContain("Bash"); // still denied: shell not widened
    expect(w.allowedTools).toContain("Write");
    expect(w.deniedTools).not.toContain("WebFetch");
    expect(w.widenings).toEqual([
      "allowedTools+Bash",
      "allowedTools+Write",
      "network",
    ]);
  });
});

describe("computeEffectivePolicy — pure", () => {
  const fileWrite = toolFactsFor("file.write");
  it("kill switch refuses everything first", () => {
    const r = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: fileWrite,
      killSwitch: { engaged: true, reason: "engaged" },
    });
    expect(r.final).toBe("REFUSED");
    expect(r.stages[0]).toMatchObject({
      stage: "kill_switch",
      verdict: "REFUSE",
    });
  });
  it("compat: cron never consults; manual consults for a high tool only", () => {
    const cron = computeEffectivePolicy({
      profile: resolveProfile({ approvalGate: "high" }),
      recipe: { name: "r" },
      trigger: "cron",
      tool: fileWrite,
      killSwitch: KS_OFF,
    });
    expect(cron.consultsApproval).toBe(false);
    expect(cron.final).toBe("ALLOW");
    const manual = computeEffectivePolicy({
      profile: resolveProfile({ approvalGate: "high" }),
      recipe: { name: "r" },
      trigger: "manual",
      tool: fileWrite,
      killSwitch: KS_OFF,
    });
    expect(manual.consultsApproval).toBe(true);
    // file.write is medium: passes under "high"
    expect(manual.final).toBe(
      fileWrite.tier === "high" ? "HUMAN_APPROVAL_REQUIRED" : "ALLOW",
    );
  });
  it("governed: cron is gated like manual; recipe opt-out ignored", () => {
    const r = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r", requireApproval: false },
      trigger: "cron",
      tool: toolFactsFor("file.write"),
      killSwitch: KS_OFF,
    });
    expect(r.consultsApproval).toBe(true);
    expect(r.stages.find((s) => s.stage === "trigger")?.reason).toMatch(
      /ignored under governed/,
    );
  });
  it("governed: an unregistered tool is refused; compat skips", () => {
    const g = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: toolFactsFor("nope.tool"),
      killSwitch: KS_OFF,
    });
    expect(g.final).toBe("REFUSED");
    const c = computeEffectivePolicy({
      profile: COMPAT_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: toolFactsFor("nope.tool"),
      killSwitch: KS_OFF,
    });
    expect(c.final).toBe("ALLOW");
    expect(c.stages.find((s) => s.stage === "tool_registration")?.verdict).toBe(
      "SKIP",
    );
  });
  it("governed: a non-reversible write asks even at medium tier; a reversible one flows", () => {
    expect(tierVerdict(GOVERNED_PROFILE, toolFactsFor("http.post")).verdict).toBe("APPROVAL");
    expect(tierVerdict(GOVERNED_PROFILE, toolFactsFor("file.write")).verdict).toBe("ALLOW");
    expect(tierVerdict(resolveProfile({ approvalGate: "high" }), toolFactsFor("http.post")).verdict).toBe("ALLOW");
  });
  it("governed: a write tool with an inferred tier needs approval", () => {
    const plugin = {
      ...toolFactsFor("acme.destroy"),
      registered: true,
      isWrite: true,
      tierDeclared: false,
    };
    expect(tierVerdict(GOVERNED_PROFILE, plugin).verdict).toBe("APPROVAL");
    expect(
      tierVerdict(resolveProfile({ approvalGate: "high" }), plugin).verdict,
    ).toBe("ALLOW");
  });
  it("governed: a contained agent step flows; an uncontained or widened one asks", () => {
    const contained = toolFactsFor("agent", {
      containment: resolveAgentContainment(GOVERNED_PROFILE, undefined),
    });
    expect(tierVerdict(GOVERNED_PROFILE, contained).verdict).toBe("ALLOW");
    const widened = toolFactsFor("agent", {
      containment: resolveAgentContainment(GOVERNED_PROFILE, { shell: true }),
    });
    expect(tierVerdict(GOVERNED_PROFILE, widened).verdict).toBe("APPROVAL");
  });
  it("worker forbid is final; worker gate + standing permission flows", () => {
    const forbid = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: fileWrite,
      worker: { id: "w", action: "forbid", ruleId: "forbid:file" },
      killSwitch: KS_OFF,
    });
    expect(forbid.final).toBe("REFUSED");
    const standing = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: fileWrite,
      worker: { id: "w", action: "gate", standingPermissionId: "sp-1" },
      killSwitch: KS_OFF,
    });
    expect(standing.final).toBe("ALLOW");
    expect(
      standing.stages.find((s) => s.stage === "standing_permission")?.verdict,
    ).toBe("ALLOW");
  });
  it("privacy refuses anything but ALLOW", () => {
    const r = computeEffectivePolicy({
      profile: GOVERNED_PROFILE,
      recipe: { name: "r" },
      trigger: "manual",
      tool: toolFactsFor("agent", {
        containment: resolveAgentContainment(GOVERNED_PROFILE, undefined),
      }),
      privacy: {
        classification: "restricted",
        destination: "anthropic",
        decision: "LOCAL_ONLY",
      },
      killSwitch: KS_OFF,
    });
    expect(r.final).toBe("REFUSED");
  });
  it("shouldConsultApproval: no fn injected ⇒ never", () => {
    expect(
      shouldConsultApproval({
        profile: GOVERNED_PROFILE,
        trigger: "manual",
        workerGateInjected: false,
        approvalFnInjected: false,
      }).consult,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PREVIEW == ENFORCEMENT
// ---------------------------------------------------------------------------

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-09-01T12:00:00Z"),
    logDir: TMP,
    testMode: false,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  };
}

const TOOLS: Array<{
  label: string;
  step: Record<string, unknown>;
  toolId: string;
}> = [
  {
    label: "file.write",
    step: { tool: "file.write", path: `${TMP}/x`, content: "1" },
    toolId: "file.write",
  },
  {
    label: "unregistered",
    step: { tool: "nope.tool", into: "n" },
    toolId: "nope.tool",
  },
];

describe("preview equals enforcement (flat runner)", () => {
  for (const profile of [
    COMPAT_PROFILE,
    resolveProfile({ approvalGate: "high" }),
    GOVERNED_PROFILE,
  ]) {
    for (const trigger of ["manual", "cron", "webhook"] as const) {
      for (const requireApproval of [undefined, false] as const) {
        for (const t of TOOLS) {
          const name = `${profile.mode}/gate=${profile.approvalGate} × ${trigger} × requireApproval=${String(requireApproval)} × ${t.label}`;
          it(name, async () => {
            const calls: Array<{ toolId: string; effective?: string }> = [];
            const requireApprovalFn = vi.fn(
              async (i: { toolId: string; effective?: string }) => {
                calls.push({ toolId: i.toolId, effective: i.effective });
                return true;
              },
            );
            const recipe = {
              name: "pe",
              trigger: { type: trigger },
              ...(requireApproval !== undefined && { requireApproval }),
              steps: [t.step],
            } as unknown as YamlRecipe;
            const injected = profile.approvalGate !== "off";
            const result = await runYamlRecipe(
              recipe,
              deps({
                governance: profile,
                ...(injected && { requireApprovalFn }),
              }),
            );
            const expected = computeEffectivePolicy({
              profile,
              recipe: {
                name: "pe",
                ...(requireApproval !== undefined && { requireApproval }),
              },
              trigger,
              tool: toolFactsFor(t.toolId),
              killSwitch: KS_OFF,
              gate: { approvalFnInjected: injected, workerGateInjected: false },
            });
            // 1. consulted iff the calculation says so
            expect(calls.length > 0).toBe(
              expected.consultsApproval && expected.final !== "REFUSED",
            );
            // 2. the verdict handed to the gate is the calculation's
            if (calls.length > 0)
              expect(calls[0]?.effective).toBe(expected.final);
            // 3. a refusal halts the run with the policy category
            if (expected.final === "REFUSED") {
              expect(result.stepResults[0]?.haltCategory).toMatch(
                /policy_denied|unresolved_tool/,
              );
            }
          });
        }
      }
    }
  }
});
