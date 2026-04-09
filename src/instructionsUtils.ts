/**
 * Shared utility for building the BRIDGE TOOL ENFORCEMENT block injected into
 * MCP initialize instructions. Centralised here so bridge.ts and
 * orchestratorBridge.ts stay in sync automatically.
 *
 * SYNC REQUIREMENT: The full tool substitution table lives in TWO places:
 *   1. templates/bridge-tools.md  — written to .claude/rules/bridge-tools.md
 *                                    (loaded into Claude's context via @import)
 *   2. The inline summary in buildEnforcementBlock() below
 *                                    (injected on every MCP initialize handshake)
 *
 * Whenever you add or rename a tool substitution rule, update BOTH locations.
 * The inline summary here is intentionally abbreviated ("+ more — see bridge-tools.md");
 * update the *categories* listed there when entire new categories are added.
 */
export function buildEnforcementBlock(): string[] {
  return [
    "BRIDGE TOOL ENFORCEMENT:",
    "  When this bridge is connected, ALWAYS call bridge MCP tools instead of shell commands:",
    "  runTests · getDiagnostics · gitCommit · searchWorkspace · batchGetHover · getChangeImpact · (+ more — see bridge-tools.md)",
    "  Full substitution table: .claude/rules/bridge-tools.md (loaded via @import in CLAUDE.md)",
  ];
}
