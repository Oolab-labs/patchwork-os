/**
 * Dashboard path that records a human's answer to a gated action.
 *
 * The bridge serves decisions at `/approve/<callId>` and `/reject/<callId>`
 * (`src/approvalHttp.ts`). There is NO `/approvals/` prefix on that route —
 * `/approvals/<callId>` is the single-call detail route. The Overview page
 * once built `/api/bridge/approvals/<decision>/<callId>` by hand, so every
 * Approve/Deny there 404'd while the other pages worked; this helper is the
 * one place the shape is written down so the call sites cannot drift apart.
 *
 * The proxy forwards the member's session (for approver attribution) only on
 * exactly this two-segment `approve|reject` shape, so a different shape would
 * also lose who decided, not just fail.
 *
 * Returns the path WITHOUT the base-path prefix; wrap it in `apiPath()`.
 */
export type ApprovalDecision = "approve" | "reject";

export function approvalDecisionPath(
  decision: ApprovalDecision,
  callId: string,
): string {
  return `/api/bridge/${decision}/${encodeURIComponent(callId)}`;
}
