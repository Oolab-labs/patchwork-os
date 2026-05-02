/**
 * approvalSignals — passive risk personalization for the approval queue.
 *
 * Computes user-specific signals based on past approval / activity history.
 * These supplement (not replace) the policy-engine `riskSignals` which are
 * computed from the call's CONTENT (params shape, destructive flags, etc.).
 *
 * Personal signals describe the user's RELATIONSHIP to this tool/call:
 * "you approved this 27 times" is a different signal class from "this
 * command contains rm -rf". Both should reach the approval modal.
 *
 * Catalog (from docs/strategic/2026-05-02/memory-ecosystem-report.md §5):
 * three of the twelve heuristics shipped here. Heuristics 4-12 follow.
 *
 *   1. "You approved similar actions N times" — past allow on same tool
 *   2. "You rejected this tool before" — past deny on same tool
 *   3. "First use of this connector" — connector namespace ∩ activity log
 *
 * The signals are **transparent**: every signal has a `source` enum so a
 * future "why is this signal here?" UI can link back to the rows that
 * produced it. We do not infer; we count and match. No model, no
 * fine-tuning. Honesty is the value proposition.
 *
 * Privacy: signals are computed locally over local logs. They flow into
 * the approval queue's PendingApproval shape, which is exposed via
 * GET /approvals (bearer-auth-gated) and the SSE stream (same auth).
 * Nothing leaves the machine.
 */

import type { ActivityLog } from "./activityLog.js";
import { isConnectorNamespace } from "./recipes/toolRegistry.js";

export interface PersonalSignal {
  kind:
    | "prior_approvals"
    | "prior_rejection"
    | "first_connector_use"
    | "first_tool_use";
  /** Human-facing label suitable for an approval modal line. */
  label: string;
  /** Severity controls visual weight. low = informational, high = warning. */
  severity: "low" | "medium" | "high";
  /** Source identifier so the UI can link the signal back to its evidence. */
  source: "approval_history" | "activity_history" | "tool_registry";
  /** Optional numeric backing the label, surfaced in tooltips / counts. */
  count?: number;
}

/**
 * Threshold under which heuristic 1 ("you approved this N times") does
 * not surface. With < 3 prior approvals the signal is noise — it could
 * be the first three exploratory calls a user always rubber-stamps. ≥ 3
 * is "you have a pattern here."
 */
const PRIOR_APPROVALS_THRESHOLD = 3;

/**
 * Compute the personal-signal set for an incoming approval request.
 *
 * Pure function over the activity log; no I/O of its own. Tested in
 * isolation by feeding a mock ActivityLog. The activityLog argument is
 * passed positionally rather than wired through deps so the surface
 * stays inspectable.
 */
export function computePersonalSignals(input: {
  toolName: string;
  activityLog: ActivityLog;
}): PersonalSignal[] {
  const { toolName, activityLog } = input;
  if (!toolName) return [];

  const signals: PersonalSignal[] = [];

  // Heuristic 1: "You approved this N times before."
  // Surface only when count crosses PRIOR_APPROVALS_THRESHOLD so we don't
  // flag every second call. Cap the message at three buckets for legibility.
  const priorApprovals = activityLog.queryApprovalDecisions({
    toolName,
    decision: "allow",
  });
  if (priorApprovals.length >= PRIOR_APPROVALS_THRESHOLD) {
    signals.push({
      kind: "prior_approvals",
      label: priorApprovalsLabel(priorApprovals.length),
      severity: "low",
      source: "approval_history",
      count: priorApprovals.length,
    });
  }

  // Heuristic 2: "You rejected this tool before."
  // Any prior rejection is signal — explicit rejections are rare and
  // intentional. Severity scales with how recent and how many.
  const priorRejections = activityLog.queryApprovalDecisions({
    toolName,
    decision: "deny",
  });
  if (priorRejections.length > 0) {
    signals.push({
      kind: "prior_rejection",
      label: priorRejectionLabel(priorRejections.length),
      severity: priorRejections.length >= 2 ? "high" : "medium",
      source: "approval_history",
      count: priorRejections.length,
    });
  }

  // Heuristic 3: "First use of this connector" / "first use of this tool".
  // For namespaced tool ids only (`namespace.subtool` shape). Two flavors:
  //   - If the namespace is in the connector registry → "first connector use"
  //     (high salience: connectors hit external services with credentials).
  //   - Otherwise, plain "first use" with low salience.
  // We require a namespaced tool id so we don't flag every CLI tool ever
  // called with no prior history (which would fire on every fresh session).
  const namespace = toolName.split(".")[0];
  if (namespace && namespace !== toolName) {
    const priorInNamespace = activityLog.queryByNamespace(namespace, 50);
    if (priorInNamespace.length === 0) {
      const isConnector = isConnectorNamespace(namespace);
      signals.push({
        kind: isConnector ? "first_connector_use" : "first_tool_use",
        label: isConnector
          ? `First use of the ${namespace} connector — credentials and external calls about to fire.`
          : `First use of any ${namespace}.* tool in this workspace.`,
        severity: isConnector ? "high" : "low",
        source: "activity_history",
      });
    }
  }

  return signals;
}

function priorApprovalsLabel(count: number): string {
  if (count >= 100) {
    return `You've approved this tool ${count}+ times — well-trusted in your workflow.`;
  }
  if (count >= 20) {
    return `You've approved this tool ${count} times before.`;
  }
  return `You've approved this tool ${count} times before.`;
}

function priorRejectionLabel(count: number): string {
  if (count === 1) {
    return "You rejected this tool once before — context may have changed since.";
  }
  return `You've rejected this tool ${count} times before — recurring pattern of caution.`;
}
