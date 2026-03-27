/**
 * Aggregates ActivityLog data into an anonymized session summary for opt-in
 * usage analytics. No file paths, arguments, error messages, or personal data.
 *
 * Plugin tool names are hashed (prefix only) to avoid leaking org-specific names.
 * Built-in tool names are sent verbatim.
 */

import crypto from "node:crypto";

/** Known built-in tool names — sent verbatim. Anything else is treated as a plugin tool. */
const BUILTIN_TOOL_NAMES = new Set([
  "getOpenEditors",
  "getCurrentSelection",
  "getLatestSelection",
  "getDiagnostics",
  "watchDiagnostics",
  "getDocumentSymbols",
  "getHover",
  "goToDefinition",
  "findReferences",
  "getCallHierarchy",
  "searchWorkspaceSymbols",
  "getCodeActions",
  "applyCodeAction",
  "renameSymbol",
  "openFile",
  "closeTab",
  "checkDocumentDirty",
  "saveDocument",
  "captureScreenshot",
  "getBridgeStatus",
  "getToolCapabilities",
  "executeVSCodeCommand",
  "getDebugState",
  "setDebugBreakpoints",
  "startDebugging",
  "stopDebugging",
  "evaluateInDebugger",
  "readFile",
  "writeFile",
  "createFile",
  "deleteFile",
  "moveFile",
  "listDirectory",
  "searchFiles",
  "searchAndReplace",
  "runCommand",
  "getGitStatus",
  "getGitDiff",
  "gitCommit",
  "gitCheckout",
  "gitPush",
  "gitPull",
  "gitLog",
  "gitWrite",
  "sendHttpRequest",
  "clipboardRead",
  "clipboardWrite",
  "getClipboard",
  "setClipboard",
  "openDiff",
  "runClaudeTask",
  "getClaudeTaskStatus",
  "cancelClaudeTask",
  "listClaudeTasks",
  "resumeClaudeTask",
  "getAIComments",
  "createGithubIssueFromAIComment",
  "switchWorkspace",
  "getOrchestratorStatus",
  "handoffNote",
  "workspaceSettings",
  "getHandoffNote",
  "writeHandoffNote",
  "logging",
]);

export interface ToolStat {
  tool: string; // verbatim for builtins, "plugin:<sha256_prefix_8>" for plugins
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

export interface AnalyticsSummary {
  bridgeVersion: string;
  sessionDurationMs: number;
  toolStats: ToolStat[];
}

/** Returns the safe tool name to include in analytics. */
function safeToolName(tool: string): string {
  if (BUILTIN_TOOL_NAMES.has(tool)) return tool;
  // Plugin tool: extract prefix (everything before first underscore) and hash it
  const prefix = tool.includes("_") ? (tool.split("_")[0] ?? tool) : tool;
  const hash = crypto
    .createHash("sha256")
    .update(prefix)
    .digest("hex")
    .slice(0, 8);
  return `plugin:${hash}`;
}

/** Compute p50 and p95 from a sorted array of durations. */
function percentiles(sorted: number[]): { p50: number; p95: number } {
  if (sorted.length === 0) return { p50: 0, p95: 0 };
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return { p50, p95 };
}

/**
 * Build an anonymized summary from raw tool call entries.
 * Accepts the same shape as ActivityLog.stats() plus raw duration arrays.
 */
export function buildSummary(
  entries: Array<{
    tool: string;
    durationMs: number;
    status: "success" | "error";
  }>,
  sessionDurationMs: number,
  bridgeVersion: string,
): AnalyticsSummary {
  // Group by safe tool name
  const map = new Map<
    string,
    { calls: number; errors: number; durations: number[] }
  >();

  for (const entry of entries) {
    const name = safeToolName(entry.tool);
    const s = map.get(name) ?? { calls: 0, errors: 0, durations: [] };
    s.calls++;
    if (entry.status === "error") s.errors++;
    s.durations.push(entry.durationMs);
    map.set(name, s);
  }

  const toolStats: ToolStat[] = [];
  for (const [tool, s] of map) {
    const sorted = [...s.durations].sort((a, b) => a - b);
    const { p50, p95 } = percentiles(sorted);
    toolStats.push({
      tool,
      calls: s.calls,
      errors: s.errors,
      p50Ms: Math.round(p50),
      p95Ms: Math.round(p95),
    });
  }

  // Sort by call count descending for readability
  toolStats.sort((a, b) => b.calls - a.calls);

  return {
    bridgeVersion,
    sessionDurationMs,
    toolStats,
  };
}
