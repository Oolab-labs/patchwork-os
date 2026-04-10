/**
 * Shared utility for building the BRIDGE TOOL ENFORCEMENT reminder injected into
 * MCP initialize instructions. Centralised here so bridge.ts and
 * orchestratorBridge.ts stay in sync automatically.
 *
 * SYNC REQUIREMENT: The full tool substitution table lives in TWO places:
 *   1. templates/bridge-tools.md  — written to .claude/rules/bridge-tools.md
 *                                    (loaded into Claude's context via @import)
 *   2. buildEnforcementReminder() below
 *                                    (injected on every MCP initialize handshake)
 *
 * Whenever you add a new tool category to templates/bridge-tools.md, add a
 * representative tool for that category here too. The CI test
 * "covers all tool categories from templates/bridge-tools.md" will fail if any
 * category has no representative tool in this reminder.
 */
export function buildEnforcementReminder(): string[] {
  return [
    "BRIDGE TOOL ENFORCEMENT:",
    "  When this bridge is connected, ALWAYS call bridge MCP tools instead of shell commands:",
    "  Testing:            runTests",
    "  Diagnostics/lint:   getDiagnostics  (replaces tsc, eslint, biome, npm run lint)",
    "  Git:                getGitStatus · getGitDiff · gitCommit · gitPush · githubCreatePR",
    "  Code search/nav:    searchWorkspace · getBufferContent · batchGetHover · batchGoToDefinition",
    "  Impact analysis:    getChangeImpact",
    "  Editor annotations: getCodeLens · getSemanticTokens",
    "  Debugging:          setDebugBreakpoints · evaluateInDebugger",
    "  File tree:          getFileTree · findFiles",
    "  Full substitution table: .claude/rules/bridge-tools.md (loaded via @import in CLAUDE.md)",
  ];
}
