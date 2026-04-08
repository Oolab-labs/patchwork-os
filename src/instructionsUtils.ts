/**
 * Shared utility for building the BRIDGE TOOL ENFORCEMENT block injected into
 * MCP initialize instructions. Centralised here so bridge.ts and
 * orchestratorBridge.ts stay in sync automatically.
 */
export function buildEnforcementBlock(): string[] {
  return [
    "BRIDGE TOOL ENFORCEMENT:",
    "  When this bridge is connected, ALWAYS call bridge MCP tools instead of shell commands:",
    "  runTests · getDiagnostics · gitCommit · searchWorkspace · batchGetHover · getChangeImpact · (+ more — see bridge-tools.md)",
    "  Full substitution table: .claude/rules/bridge-tools.md (loaded via @import in CLAUDE.md)",
  ];
}
