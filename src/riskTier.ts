/**
 * Risk tier registry — classifies MCP tools so the dashboard approval flow
 * knows which calls need human sign-off before dispatch.
 *
 * Defaults are deliberately conservative. Unknown tools default to "medium"
 * until someone classifies them (safer than auto-approving).
 *
 * ── Alignment with Claude Code permissions (https://code.claude.com/docs/en/permissions)
 *
 * CC classifies tools by *behavior*, not by abstract risk. Our tiers map to
 * CC's built-in categories as follows:
 *
 *   low    → read-only    — CC never prompts (Read, Grep, Glob, etc.)
 *   medium → file-mod     — CC prompts, remembered for the session
 *   high   → shell-exec   — CC prompts, remembered permanently per command
 *                         + external-side-effect (gitPush, sendHttpRequest,
 *                           githubCreatePR) — always requires approval
 *
 * CC's decision precedence is `deny → ask → allow` via rules in
 * `permissions.{allow,ask,deny}` (settings.json). Our ApprovalQueue +
 * /approvals endpoint plug in as a PreToolUse hook backend so the dashboard
 * can serve as a browser/phone approval UI for CC itself. See
 * scripts/patchwork-approval-hook.sh.
 */

export type RiskTier = "low" | "medium" | "high";

/** CC-native behavior class. Prefer this over RiskTier for new code. */
export type ToolBehavior =
  | "readOnly"
  | "localWrite"
  | "shellExec"
  | "externalEffect";

const BEHAVIOR_FROM_TIER: Record<RiskTier, ToolBehavior> = {
  low: "readOnly",
  medium: "localWrite",
  high: "externalEffect",
};

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
  Bash: "high",
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

/**
 * Infer a risk tier from the tool name when the hardcoded map has no entry.
 * Lets us classify newly-added tools without maintaining a parallel list.
 * Heuristics ordered from most-specific to most-general; first match wins.
 */
export function inferTierFromName(toolName: string): RiskTier {
  const n = toolName;
  // Write / destructive / external
  if (
    /^(git(Push|Pull|Fetch|Commit))$/.test(n) ||
    /^github(Create|Comment|Post|Delete)/.test(n) ||
    /^(delete|unlink|drop)[A-Z]/.test(n) ||
    n === "renameFile" ||
    /^(run|exec|spawn|send|start|stop|kill|launch|resume|cancel)[A-Z]/.test(
      n,
    ) ||
    /^(open|execute|dispatch)[A-Z]/.test(n) ||
    n === "sendHttpRequest"
  )
    return "high";

  // Local writes
  if (
    /^(edit|write|create|save|format|apply|fix|refactor|rename|organize|stage|commit|add|stash)[A-Z]/.test(
      n,
    ) ||
    /(^set|^update|^replace)[A-Z]/.test(n) ||
    /search[A-Z].*Replace/i.test(n)
  )
    return "medium";

  // Reads
  if (
    /^(get|find|search|list|read|describe|explain|goTo|hover|preview|capture|explore|resolve|probe|check|lookup|parse|classify|compute|compare|render|validate|ping|ready|detect|watch)/.test(
      n,
    ) ||
    n === "contextBundle"
  )
    return "low";

  return "medium";
}

export function classifyTool(toolName: string): RiskTier {
  return TIER_MAP[toolName] ?? inferTierFromName(toolName);
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

/** Derive CC-native behavior class from tool name. */
export function classifyBehavior(toolName: string): ToolBehavior {
  return BEHAVIOR_FROM_TIER[classifyTool(toolName)];
}
