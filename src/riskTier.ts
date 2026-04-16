/**
 * Risk tier registry — classifies MCP tools so the dashboard approval flow
 * knows which calls need human sign-off before dispatch.
 *
 * Defaults are deliberately conservative. Unknown tools default to "medium"
 * until someone classifies them (safer than auto-approving).
 */

export type RiskTier = "low" | "medium" | "high";

const TIER_MAP: Record<string, RiskTier> = {
  // ── low: pure reads ───────────────────────────────────────────────────────
  getBufferContent: "low",
  getDiagnostics: "low",
  getFileTree: "low",
  findFiles: "low",
  searchWorkspace: "low",
  searchWorkspaceSymbols: "low",
  goToDefinition: "low",
  findReferences: "low",
  getCallHierarchy: "low",
  getDocumentSymbols: "low",
  getHover: "low",
  getHoverAtCursor: "low",
  getGitStatus: "low",
  getGitDiff: "low",
  getGitLog: "low",
  getBridgeStatus: "low",
  getToolCapabilities: "low",
  getActivityLog: "low",
  getOpenEditors: "low",
  contextBundle: "low",
  getCodeLens: "low",
  getSemanticTokens: "low",
  getProjectInfo: "low",
  captureScreenshot: "low",
  gitBlame: "low",

  // ── medium: local writes + reversible edits ───────────────────────────────
  editText: "medium",
  createFile: "medium",
  saveDocument: "medium",
  formatDocument: "medium",
  formatAndSave: "medium",
  organizeImports: "medium",
  renameSymbol: "medium",
  refactorExtractFunction: "medium",
  searchAndReplace: "medium",
  applyCodeAction: "medium",
  fixAllLintErrors: "medium",
  runTests: "medium",
  setHandoffNote: "medium",
  gitAdd: "medium",
  gitStash: "medium",
  gitStashPop: "medium",
  gitCheckout: "medium",

  // ── high: remote state, destructive, or side-effect externally ────────────
  gitCommit: "high",
  gitPush: "high",
  gitPull: "high",
  gitFetch: "high",
  githubCreatePR: "high",
  githubCommentIssue: "high",
  githubCreateIssue: "high",
  githubPostPRReview: "high",
  runCommand: "high",
  runInTerminal: "high",
  sendTerminalCommand: "high",
  deleteFile: "high",
  renameFile: "high",
  sendHttpRequest: "high",
  executeVSCodeCommand: "high",
  runClaudeTask: "high",
  resumeClaudeTask: "high",
  evaluateInDebugger: "high",
};

export function classifyTool(toolName: string): RiskTier {
  return TIER_MAP[toolName] ?? "medium";
}

export function requiresApproval(
  toolName: string,
  policy: RiskTier[] = ["high"],
): boolean {
  return policy.includes(classifyTool(toolName));
}

export function riskTierSummary(): Record<RiskTier, number> {
  const counts: Record<RiskTier, number> = { low: 0, medium: 0, high: 0 };
  for (const t of Object.values(TIER_MAP)) counts[t]++;
  return counts;
}

/** Exposed for tests and the dashboard registry endpoint. */
export function getRiskTierMap(): Readonly<Record<string, RiskTier>> {
  return TIER_MAP;
}
