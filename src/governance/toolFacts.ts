/**
 * ToolFacts from the live recipe tool registry — the single place that turns
 * a tool id into the facts `computeEffectivePolicy` needs. Used by the
 * runners at the consult point AND by `patchwork policy explain`, so both
 * describe the same tool the same way.
 */

import { classifyTool } from "../riskTier.js";
import { getTool } from "../recipes/toolRegistry.js";
import type { ToolFacts } from "./effectivePolicy.js";
import type { AgentContainment } from "./profile.js";

export function toolFactsFor(
  toolId: string,
  agent?: { containment: AgentContainment } | undefined,
): ToolFacts {
  if (toolId === "agent") {
    return {
      id: "agent",
      tier: classifyTool("agent"),
      tierDeclared: false,
      registered: true,
      isAgentStep: true,
      ...(agent && {
        agentContained: agent.containment.enforced,
        agentWidenings: agent.containment.widenings,
      }),
    };
  }
  const reg = getTool(toolId);
  if (!reg) {
    return {
      id: toolId,
      tier: classifyTool(toolId),
      tierDeclared: false,
      registered: false,
    };
  }
  return {
    id: toolId,
    tier: classifyTool(toolId),
    // The registry resolver supplies riskDefault to classifyTool, so a
    // registered tool's tier is declared by construction. Plugin tools are
    // registered through `registerPluginTools` with a capped default and are
    // flagged there (see toolRegistry.ts) — they carry `pluginTier: true`.
    tierDeclared: !(reg as { fromPlugin?: boolean }).fromPlugin,
    isWrite: reg.isWrite,
    registered: true,
  };
}
