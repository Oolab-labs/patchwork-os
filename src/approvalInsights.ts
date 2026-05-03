/**
 * approvalInsights — aggregate approval-decision history into per-tool
 * heuristic summaries.
 *
 * Phase 3 §3 of the strategic plan: surface the transparent heuristics that
 * are computed *per-approval* in approvalSignals.ts as an aggregated view
 * so the user can understand their overall approval patterns — not just what
 * a specific pending call looks like to the system.
 *
 * Queries: all `approval_decision` lifecycle entries from the in-memory
 * activityLog ring (same source as computePersonalSignals). No model, no
 * fine-tuning. Counts and timestamps only.
 */

import type { ActivityLog } from "./activityLog.js";

export interface ToolInsight {
  /** Tool name as recorded in approval_decision metadata. */
  toolName: string;
  /** Total allow decisions. */
  approvals: number;
  /** Total deny/reject decisions. */
  rejections: number;
  /** Approval rate 0–1 (null when no decisions). */
  approvalRate: number | null;
  /** ISO-8601 timestamp of the most recent decision, or null. */
  lastDecisionAt: string | null;
  /** ISO-8601 timestamp of the first ever decision, or null. */
  firstDecisionAt: string | null;
  /**
   * Human-readable heuristic label synthesised from the above numbers.
   * Mirrors the language used in approvalSignals "prior_approvals" /
   * "prior_rejection" signals so the user sees consistent wording.
   */
  heuristicLabel: string;
  /** Severity level for dashboard visual weight. */
  severity: "low" | "medium" | "high";
}

export interface ApprovalInsightsResult {
  /** Per-tool summaries, sorted by total decisions descending. */
  tools: ToolInsight[];
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  /** Total decisions across all tools. */
  totalDecisions: number;
  /** Tools with at least one rejection. */
  rejectedToolCount: number;
  /** Tools with ≥ 3 approvals and zero rejections. */
  trustedToolCount: number;
}

function heuristicLabel(approvals: number, rejections: number): string {
  const total = approvals + rejections;
  if (total === 0) return "No decisions yet";
  if (rejections === 0) {
    if (approvals === 1) return "Approved once";
    if (approvals < 5) return `Approved ${approvals} times`;
    return `Approved ${approvals} times — pattern established`;
  }
  if (approvals === 0) {
    return rejections === 1
      ? "Rejected once — you blocked this tool"
      : `Rejected ${rejections} times — you consistently block this tool`;
  }
  const rate = Math.round((approvals / total) * 100);
  if (rate >= 80)
    return `Approved ${approvals}×, rejected ${rejections}× (${rate}% approval rate)`;
  if (rate >= 50)
    return `Mixed history: ${approvals} approvals, ${rejections} rejections`;
  return `Mostly rejected: ${rejections} rejections vs ${approvals} approvals`;
}

function severity(
  approvals: number,
  rejections: number,
): "low" | "medium" | "high" {
  if (rejections > 0) return "high";
  if (approvals >= 5) return "low";
  return "medium";
}

export function computeApprovalInsights(
  activityLog: ActivityLog,
): ApprovalInsightsResult {
  const decisions = activityLog.queryApprovalDecisions();

  // Aggregate by toolName.
  const byTool = new Map<
    string,
    {
      approvals: number;
      rejections: number;
      timestamps: string[];
    }
  >();

  for (const entry of decisions) {
    const toolName =
      typeof entry.metadata?.toolName === "string"
        ? entry.metadata.toolName
        : "(unknown)";
    const decision =
      typeof entry.metadata?.decision === "string"
        ? entry.metadata.decision
        : "";
    let bucket = byTool.get(toolName);
    if (!bucket) {
      bucket = { approvals: 0, rejections: 0, timestamps: [] };
      byTool.set(toolName, bucket);
    }
    if (decision === "allow") bucket.approvals++;
    else if (decision === "deny" || decision === "reject") bucket.rejections++;
    bucket.timestamps.push(entry.timestamp);
  }

  const tools: ToolInsight[] = [];
  for (const [toolName, bucket] of byTool) {
    const total = bucket.approvals + bucket.rejections;
    const sorted = [...bucket.timestamps].sort();
    tools.push({
      toolName,
      approvals: bucket.approvals,
      rejections: bucket.rejections,
      approvalRate: total > 0 ? bucket.approvals / total : null,
      lastDecisionAt: sorted[sorted.length - 1] ?? null,
      firstDecisionAt: sorted[0] ?? null,
      heuristicLabel: heuristicLabel(bucket.approvals, bucket.rejections),
      severity: severity(bucket.approvals, bucket.rejections),
    });
  }

  // Sort by total decisions descending, then toolName ascending.
  tools.sort((a, b) => {
    const totA = a.approvals + a.rejections;
    const totB = b.approvals + b.rejections;
    if (totB !== totA) return totB - totA;
    return a.toolName.localeCompare(b.toolName);
  });

  return {
    tools,
    generatedAt: new Date().toISOString(),
    totalDecisions: decisions.length,
    rejectedToolCount: tools.filter((t) => t.rejections > 0).length,
    trustedToolCount: tools.filter(
      (t) => t.approvals >= 3 && t.rejections === 0,
    ).length,
  };
}
