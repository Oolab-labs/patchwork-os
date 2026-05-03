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
 *   5. "Last called T days ago" — gap since most recent call (heuristic 4
 *      from the catalog is satisfied by the first_connector_use kind above)
 *   7. "Risk tier escalation" — current tier exceeds the user's typical
 *      approved tier across recent decisions
 *   8. "Often runs alongside X" — co-occurrence pairing in recent activity
 *   9. "Workspace mismatch" — call from a workspace that has never
 *      approved this tool before
 *  12. "Cooldown breach" — same tool fired N+ times in a short window
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
import type { RiskTier } from "./riskTier.js";

export interface PersonalSignal {
  kind:
    | "prior_approvals"
    | "prior_rejection"
    | "first_connector_use"
    | "first_tool_use"
    | "stale_tool_use"
    | "tier_escalation"
    | "cooccurrence_pattern"
    | "cooldown_breach"
    | "workspace_mismatch";
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
 * Minimum gap before "you haven't used this in a while" surfaces. Under a
 * week the user almost certainly remembers; past a week, the call may
 * deserve a second look. Tunable, not load-bearing — change freely if
 * dashboard feedback says it's noisy or too quiet.
 */
const STALE_TOOL_DAYS = 7;
const STALE_TOOL_MS = STALE_TOOL_DAYS * 24 * 60 * 60 * 1_000;
/** Bumped severity threshold — past a month away is "have you forgotten what this does" territory. */
const STALE_TOOL_HIGH_DAYS = 30;

/**
 * Minimum prior-allow decisions needed to establish a "typical tier"
 * baseline for heuristic 7. Below this we don't claim to know the user's
 * pattern — first few approvals could be anything. 5 is small but enough
 * to make a single outlier not dominate.
 */
const TIER_BASELINE_MIN_SAMPLES = 5;

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/**
 * Window for co-occurrence detection — 15 minutes lines up with the
 * catalog's heuristic 8 description and is wide enough to capture an
 * "I'm in the middle of doing X" workflow without crossing session
 * boundaries.
 */
const COOCCURRENCE_WINDOW_MS = 15 * 60 * 1_000;
/** Minimum co-occurrence count before the chip surfaces. < 3 is noise. */
const COOCCURRENCE_MIN_COUNT = 3;

/**
 * Cooldown-breach window — five minutes is short enough that "fired N
 * times" is a behavioral pattern (a runaway loop, a panicked retry, a
 * stuck recipe) rather than ordinary use. ApprovalQueue.inflightKey
 * already deduplicates concurrent identical requests; this surfaces the
 * cumulative pattern that inflight dedup hides.
 */
const COOLDOWN_WINDOW_MS = 5 * 60 * 1_000;
/** Min repeat count inside the window before the chip surfaces. */
const COOLDOWN_BREACH_MIN = 3;
/** Severity bumps to high once the burst is unmistakable. */
const COOLDOWN_BREACH_HIGH = 6;

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
  /**
   * Risk tier of the *current* call, used by heuristic 7. Optional —
   * pre-#126 callers and the test fixtures that omit it simply skip
   * tier-escalation evaluation.
   */
  currentTier?: RiskTier;
  /**
   * Absolute workspace path of the *current* call, used by heuristic 9
   * (workspace mismatch). Optional — when omitted, h9 is skipped.
   * Approval-decision rows persisted before workspace was captured on
   * the lifecycle metadata also degrade gracefully (treated as having
   * no baseline).
   */
  currentWorkspace?: string;
}): PersonalSignal[] {
  const { toolName, activityLog, currentTier, currentWorkspace } = input;
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

  // Heuristic 5: "Last called T days ago."
  // Surfaces a low/medium signal when the user hasn't called this exact
  // tool in a while. The message gives the user a beat to reconsider —
  // memory of *why* a call was approved fades faster than the data does.
  // No signal at all when there's no prior call (heuristic 3 handles
  // first-use); no signal when the gap is under STALE_TOOL_DAYS.
  const lastCall = activityLog.queryLastToolCall(toolName);
  if (lastCall) {
    const lastMs = Date.parse(lastCall.timestamp);
    const gapMs = Number.isFinite(lastMs) ? Date.now() - lastMs : 0;
    if (gapMs >= STALE_TOOL_MS) {
      const days = Math.floor(gapMs / (24 * 60 * 60 * 1_000));
      signals.push({
        kind: "stale_tool_use",
        label: staleToolLabel(days),
        severity: days >= STALE_TOOL_HIGH_DAYS ? "medium" : "low",
        source: "activity_history",
        count: days,
      });
    }
  }

  // Heuristic 7: "Risk tier escalation."
  // Compare the incoming call's tier against the user's typical approved
  // tier across recent allow-decisions. If the user usually approves low
  // and this is medium/high — or usually medium and this is high — surface.
  // Cross-tool: the question is "is this user's threshold being exceeded",
  // not "is this tool a step up from this tool's history". The latter is
  // covered by heuristic 1 (prior approvals on the same tool).
  if (currentTier) {
    const recentAllows = activityLog
      .queryApprovalDecisions({ decision: "allow", last: 50 })
      .filter(
        (e): e is typeof e & { metadata: { tier: RiskTier } } =>
          e.metadata?.tier === "low" ||
          e.metadata?.tier === "medium" ||
          e.metadata?.tier === "high",
      );
    if (recentAllows.length >= TIER_BASELINE_MIN_SAMPLES) {
      // p50 over rank space — sort ranks, pick the middle. Equivalent to
      // median; cheaper than a full distribution and stable on small N.
      const ranks = recentAllows
        .map((e) => TIER_RANK[e.metadata.tier])
        .sort((a, b) => a - b);
      const baselineRank = ranks[Math.floor(ranks.length / 2)] ?? 0;
      const currentRank = TIER_RANK[currentTier];
      if (currentRank > baselineRank) {
        const baselineTier = (Object.keys(TIER_RANK) as RiskTier[]).find(
          (t) => TIER_RANK[t] === baselineRank,
        );
        const jump = currentRank - baselineRank;
        signals.push({
          kind: "tier_escalation",
          label: tierEscalationLabel(baselineTier ?? "low", currentTier),
          // jump of 1 (low→med, med→high) = medium; jump of 2 (low→high) = high
          severity: jump >= 2 ? "high" : "medium",
          source: "approval_history",
        });
      }
    }
  }

  // Heuristic 8: "Often runs alongside X."
  // Informational chip — when the user calls this tool it tends to run
  // near another tool (within 15min). Surfaces the strongest partner.
  // Distinct from heuristic 1 (history of THIS tool); this signal is
  // about the workflow shape: "you're probably mid-deploy" / "this is
  // your morning-brief sequence". Severity always low — this is context,
  // not warning. Catalog flags this as medium-FP, so we underclaim.
  const pairs = activityLog.coOccurrence(COOCCURRENCE_WINDOW_MS);
  let bestPartner: { name: string; count: number } | null = null;
  for (const { pair, count } of pairs) {
    if (count < COOCCURRENCE_MIN_COUNT) continue;
    const [a, b] = pair.split("|");
    const partner = a === toolName ? b : b === toolName ? a : null;
    if (!partner) continue;
    // pairs is sorted by count desc, so the first match is the strongest.
    bestPartner = { name: partner, count };
    break;
  }
  if (bestPartner) {
    signals.push({
      kind: "cooccurrence_pattern",
      label: `Often runs alongside ${bestPartner.name} (${bestPartner.count} co-occurrences in your recent activity).`,
      severity: "low",
      source: "activity_history",
      count: bestPartner.count,
    });
  }

  // Heuristic 9: "Workspace mismatch."
  // Surfaces when this tool has been approved (allow OR deny — any
  // human decision counts as a "this workspace has seen this tool"
  // signal) in other workspaces but not in the one the call is coming
  // from. Catches "I just opened a new project and the agent wants to
  // run the same risky tool — fresh workspace, no consent record."
  // Skipped when currentWorkspace is missing (test fixtures, callers
  // without a workspace context).
  if (currentWorkspace) {
    const allDecisions = activityLog.queryApprovalDecisions({ toolName });
    const seenWorkspaces = new Set<string>();
    let priorWithWorkspace = 0;
    for (const e of allDecisions) {
      const ws = e.metadata?.workspace;
      if (typeof ws === "string" && ws.length > 0) {
        seenWorkspaces.add(ws);
        priorWithWorkspace++;
      }
    }
    // Need ≥ 1 prior decision *with workspace metadata* to claim a
    // baseline. Older rows lacking the field can't tell us anything.
    if (priorWithWorkspace > 0 && !seenWorkspaces.has(currentWorkspace)) {
      signals.push({
        kind: "workspace_mismatch",
        label: workspaceMismatchLabel(seenWorkspaces.size),
        // Catalog says "FP low" — workspace is a strong intent boundary.
        // But it's still informational rather than a hard warning.
        severity: "medium",
        source: "approval_history",
        count: seenWorkspaces.size,
      });
    }
  }

  // Heuristic 12: "Cooldown breach."
  // Same tool fired N+ times within a short window — pattern of a runaway
  // loop, panicked retry, or stuck recipe. Distinct from heuristic 1
  // (long-tail history): h1 says "you usually approve this", h12 says
  // "you're approving this RIGHT NOW more than usual." Approvals modal
  // should show both when both fire.
  const recentCalls = activityLog.query({ tool: toolName, last: 50 });
  const cutoff = Date.now() - COOLDOWN_WINDOW_MS;
  const burstCount = recentCalls.filter(
    (e) => Date.parse(e.timestamp) >= cutoff,
  ).length;
  if (burstCount >= COOLDOWN_BREACH_MIN) {
    signals.push({
      kind: "cooldown_breach",
      label: cooldownBreachLabel(burstCount),
      severity: burstCount >= COOLDOWN_BREACH_HIGH ? "high" : "medium",
      source: "activity_history",
      count: burstCount,
    });
  }

  return signals;
}

function workspaceMismatchLabel(otherCount: number): string {
  if (otherCount === 1) {
    return "Approved in a different workspace before — first time you've allowed it here.";
  }
  return `Approved in ${otherCount} other workspaces before — first time you've allowed it here.`;
}

function cooldownBreachLabel(count: number): string {
  return `Called ${count} times in the last 5 minutes — possible runaway loop or panicked retry.`;
}

function tierEscalationLabel(baseline: RiskTier, current: RiskTier): string {
  return `You usually approve ${baseline}-tier calls — this one is ${current}.`;
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

function staleToolLabel(days: number): string {
  if (days >= 365) return `Last called over a year ago (${days} days).`;
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return `Last called ${months === 1 ? "a month" : `${months} months`} ago — context may have changed since.`;
  }
  return `Last called ${days} days ago.`;
}

function priorRejectionLabel(count: number): string {
  if (count === 1) {
    return "You rejected this tool once before — context may have changed since.";
  }
  return `You've rejected this tool ${count} times before — recurring pattern of caution.`;
}
