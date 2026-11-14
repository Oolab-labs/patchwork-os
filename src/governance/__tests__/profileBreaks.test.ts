/**
 * Governed-profile settings that a mutation run (Stryker, 2026-11-14) showed
 * could be flipped with the existing suite still green.
 */

import { describe, expect, it } from "vitest";
import { shouldConsultApproval } from "../effectivePolicy.js";
import {
  CONTAINED_AGENT_DENIED_TOOLS,
  resolveAgentContainment,
  resolveProfile,
} from "../profile.js";

const governed = resolveProfile({ profile: "governed" });
const compat = resolveProfile({ approvalGate: "high" });

describe("a recipe's requireApproval: false", () => {
  it("is ignored under governed and honoured under compat", () => {
    expect(governed.recipeOptOutHonoured).toBe(false);
    expect(compat.recipeOptOutHonoured).toBe(true);
    const ask = (profile: typeof governed) =>
      shouldConsultApproval({
        profile,
        trigger: "manual",
        recipeRequireApproval: false,
        workerGateInjected: false,
        approvalFnInjected: true,
      }).consult;
    expect(ask(governed)).toBe(true);
    expect(ask(compat)).toBe(false);
  });
});

describe("contained agent steps", () => {
  const DENIED = [
    "WebFetch",
    "WebSearch",
    "Bash",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
  ];

  it("deny network, shell and every write tool by default under governed", () => {
    for (const t of DENIED) expect(CONTAINED_AGENT_DENIED_TOOLS).toContain(t);
    const c = resolveAgentContainment(governed, undefined);
    for (const t of DENIED) expect(c.deniedTools, t).toContain(t);
    expect(c.allowedTools.sort()).toEqual(["Glob", "Grep", "LS", "Read"]);
    expect(c.mcpAccess).toBe(false);
  });

  it("a recipe cannot add a denied tool through allowedTools", () => {
    const c = resolveAgentContainment(governed, {
      allowedTools: ["Bash", "WebFetch"],
    });
    expect(c.allowedTools).not.toContain("Bash");
    expect(c.allowedTools).not.toContain("WebFetch");
    expect(c.deniedTools).toEqual(expect.arrayContaining(["Bash", "WebFetch"]));
  });

  it("under compat, a sandboxed step gets bridge MCP only when it asks", () => {
    expect(resolveAgentContainment(compat, { sandbox: true }).mcpAccess).toBe(
      false,
    );
    expect(resolveAgentContainment(compat, undefined).mcpAccess).toBe(false);
    expect(
      resolveAgentContainment(compat, { sandbox: true, mcpAccess: true })
        .mcpAccess,
    ).toBe(true);
  });
});
