/**
 * Shared utility for building the BRIDGE TOOL ENFORCEMENT block injected into
 * MCP initialize instructions. Centralised here so bridge.ts and
 * orchestratorBridge.ts stay in sync automatically.
 */
export function buildEnforcementBlock(): string[] {
  return [
    "BRIDGE TOOL ENFORCEMENT:",
    "  When this bridge is connected, ALWAYS call bridge MCP tools instead of shell commands:",
    "  runTests (not npm test) · getDiagnostics (not tsc/eslint) · gitCommit (not git commit) · searchWorkspace (not grep)",
    "  Full substitution table: .claude/rules/bridge-tools.md (loaded via @import in CLAUDE.md)",
  ];
}
