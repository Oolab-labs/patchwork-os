/**
 * decisionReplay — Phase 3 §2 Decision Replay Debugger.
 *
 * "What would have happened if this new policy had been active last Tuesday?"
 *
 * Reads historical `approval_decision` lifecycle entries from the activity
 * log ring, re-evaluates each against the CURRENT CC permission rules, and
 * returns a diff: which decisions would have changed (allow→deny, deny→allow)
 * under the new policy.
 *
 * Constraints:
 * - Read-only: no side effects, no queuing, no re-execution of tools.
 * - Transparent: every result row links back to the original decision via
 *   timestamp + toolName so a future "why?" UI can surface the raw row.
 * - Graceful degradation: rows that predate the params/tier capture (before
 *   the capture PR) are still replayed — they just miss the specifier, so
 *   the rule match is tool-name-only. Noted in the result via `incomplete`.
 */

import type { ActivityLog } from "./activityLog.js";
import { evaluateRules, loadCcPermissions } from "./ccPermissions.js";

export type ReplayDecision = "allow" | "deny" | "ask" | "none";

export interface ReplayRow {
  /** ISO-8601 timestamp of the original decision. */
  timestamp: string;
  toolName: string;
  /** Specifier (e.g. command string) captured at decision time, if present. */
  specifier?: string;
  /** Decision recorded in the activity log. */
  originalDecision: string;
  /** Decision the current policy would produce. */
  replayDecision: ReplayDecision;
  /** True when original === replay. */
  unchanged: boolean;
  /**
   * Direction of change for changed rows:
   *   "now_allowed"  — was deny/ask, would now be allow
   *   "now_denied"   — was allow, would now be deny/ask
   *   "now_asked"    — was allow/deny, would now be ask
   */
  changeKind?: "now_allowed" | "now_denied" | "now_asked";
  /**
   * True when the row lacked specifier / params capture (pre-capture rows).
   * The replay is still computed, but only on tool name — may produce
   * fewer/more matches than the original if specifier-scoped rules exist.
   */
  incomplete?: boolean;
}

export interface DecisionReplayResult {
  /** All replayed rows in chronological order. */
  rows: ReplayRow[];
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  /** Total rows evaluated. */
  totalRows: number;
  /** Rows where the decision would have changed. */
  changedCount: number;
  /** Rows that would flip from deny/ask → allow under current policy. */
  nowAllowedCount: number;
  /** Rows that would flip from allow → deny/ask under current policy. */
  nowDeniedCount: number;
  /** Workspace path used to load current rules. */
  workspace: string;
}

function changeKind(
  original: string,
  replay: ReplayDecision,
): ReplayRow["changeKind"] | undefined {
  if (replay === "allow" && original !== "allow") return "now_allowed";
  if ((replay === "deny" || replay === "none") && original === "allow")
    return "now_denied";
  if (replay === "ask" && original !== "ask") return "now_asked";
  return undefined;
}

export function computeDecisionReplay(
  activityLog: ActivityLog,
  opts: {
    workspace: string;
    /** Only replay decisions newer than this epoch ms. 0 = all. */
    sinceMs?: number;
    /** Cap at this many rows (newest-first after filter). Default 500. */
    limit?: number;
    /** Override the CC permissions loader — used in tests. */
    loadRulesFn?: typeof loadCcPermissions;
  },
): DecisionReplayResult {
  const { workspace, sinceMs = 0, limit = 500 } = opts;
  const loadRules = opts.loadRulesFn ?? loadCcPermissions;

  // Load current rules once — same workspace as the bridge is running in.
  const rules = loadRules(workspace);

  // Pull all approval_decision entries, apply time filter, cap.
  const all = activityLog.queryApprovalDecisions();
  const filtered =
    sinceMs > 0 ? all.filter((e) => Date.parse(e.timestamp) >= sinceMs) : all;
  const capped = filtered.slice(-Math.min(limit, 500));

  const rows: ReplayRow[] = [];
  for (const entry of capped) {
    const toolName =
      typeof entry.metadata?.toolName === "string"
        ? entry.metadata.toolName
        : null;
    if (!toolName) continue;

    const originalDecision =
      typeof entry.metadata?.decision === "string"
        ? entry.metadata.decision
        : "unknown";

    // Specifier: stored as metadata.specifier (string) or derived from
    // params.command / params.path / params.url — whichever was captured.
    let specifier: string | undefined;
    const rawSpecifier = entry.metadata?.specifier;
    if (typeof rawSpecifier === "string") {
      specifier = rawSpecifier;
    } else {
      const params = entry.metadata?.params as
        | Record<string, unknown>
        | undefined;
      const cmd =
        params?.command ?? params?.path ?? params?.url ?? params?.pattern;
      if (typeof cmd === "string") specifier = cmd;
    }

    const incomplete = specifier === undefined;
    const replay = evaluateRules(toolName, specifier, rules);

    const unchanged =
      replay === originalDecision ||
      (replay === "none" && originalDecision === "allow") ||
      (replay === "none" && originalDecision === "deny");

    rows.push({
      timestamp: entry.timestamp,
      toolName,
      ...(specifier !== undefined && { specifier }),
      originalDecision,
      replayDecision: replay,
      unchanged,
      ...(changeKind(originalDecision, replay) !== undefined && {
        changeKind: changeKind(originalDecision, replay),
      }),
      ...(incomplete && { incomplete: true }),
    });
  }

  const changedRows = rows.filter((r) => !r.unchanged);

  return {
    rows,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    changedCount: changedRows.length,
    nowAllowedCount: changedRows.filter((r) => r.changeKind === "now_allowed")
      .length,
    nowDeniedCount: changedRows.filter((r) => r.changeKind === "now_denied")
      .length,
    workspace,
  };
}
