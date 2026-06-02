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
   * Direction of change for changed rows, keyed off the NEW (replay) outcome:
   *   "now_allowed"  — would now be allow (was deny/ask/none)
   *   "now_denied"   — would now be deny or none/blocked (was allow/ask/none)
   *   "now_asked"    — would now be ask (was allow/deny/none)
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
  /** Rows that would flip to allow under current policy. */
  nowAllowedCount: number;
  /** Rows that would flip to deny/none (effectively blocked) under current policy. */
  nowDeniedCount: number;
  /** Rows that would flip to ask under current policy. */
  nowAskedCount: number;
  /** Workspace path used to load current rules. */
  workspace: string;
}

/**
 * Decide whether two decisions are equivalent for replay purposes.
 *
 * A `replay` of "none" (no current rule matched) is treated as unchanged when
 * the original was "allow" or "deny" — absence of an explicit rule defaults to
 * the same effective outcome the user already saw, so it is not a real flip.
 */
function isUnchanged(original: string, replay: ReplayDecision): boolean {
  return (
    replay === original ||
    (replay === "none" && original === "allow") ||
    (replay === "none" && original === "deny")
  );
}

/**
 * Bucket a CHANGED row by its NEW (replay) outcome. Keyed purely off the replay
 * direction so every changed row maps to exactly one bucket and the three
 * bucket counts always sum to changedCount:
 *   - replay "allow"        → now_allowed
 *   - replay "ask"          → now_asked
 *   - replay "deny"/"none"  → now_denied (effectively blocked)
 *
 * Returns undefined for unchanged rows (no bucket).
 */
function changeKind(
  original: string,
  replay: ReplayDecision,
): ReplayRow["changeKind"] | undefined {
  if (isUnchanged(original, replay)) return undefined;
  if (replay === "allow") return "now_allowed";
  if (replay === "ask") return "now_asked";
  // A changed row whose replay is "deny" or "none" is effectively now blocked.
  return "now_denied";
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

    const unchanged = isUnchanged(originalDecision, replay);
    const kind = changeKind(originalDecision, replay);

    rows.push({
      timestamp: entry.timestamp,
      toolName,
      ...(specifier !== undefined && { specifier }),
      originalDecision,
      replayDecision: replay,
      unchanged,
      ...(kind !== undefined && { changeKind: kind }),
      ...(incomplete && { incomplete: true }),
    });
  }

  let changedCount = 0;
  let nowAllowedCount = 0;
  let nowDeniedCount = 0;
  let nowAskedCount = 0;
  for (const r of rows) {
    if (r.unchanged) continue;
    changedCount++;
    if (r.changeKind === "now_allowed") nowAllowedCount++;
    else if (r.changeKind === "now_denied") nowDeniedCount++;
    else if (r.changeKind === "now_asked") nowAskedCount++;
  }

  return {
    rows,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    changedCount,
    nowAllowedCount,
    nowDeniedCount,
    nowAskedCount,
    workspace,
  };
}
