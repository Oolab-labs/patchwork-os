/**
 * Separation of duties for gated approvals (ADR-0020, 2026-11-14 amendment).
 *
 * Two rules, applied on the approve route BEFORE `queue.approve()` runs, so a
 * refused approval never takes effect:
 *
 *   1. **Self-approval.** A request carries `preparedBy` when a named member
 *      started the run from the dashboard. That member may not approve it.
 *   2. **Named approval required.** When `requireNamedApprover` is on, an
 *      approval that names nobody (a shared-password session, no session, the
 *      phone token path) is refused.
 *
 * Rule 2 is on only when the bridge can honour it: the governed profile, a
 * session secret to verify named sessions with, and at least one active human
 * member with a login. Without a login nobody could ever approve, so the rule
 * would lock the workspace; that is ADR-0020's reason 1 for not narrowing an
 * install that has no roster.
 *
 * Rejecting is never restricted. Refusing an action is the safe direction,
 * and blocking it would leave an operator unable to stop a run.
 */

import type { ActorSnapshot } from "./approverFromSession.js";
import type { Roster } from "./roster.js";

/** True when at least one active human member has a usable login. */
export function memberLoginsExist(
  roster: Roster,
  credentials: { credentialFor(memberId: string): string | undefined },
): boolean {
  if (roster.implicit) return false;
  return roster.members.some(
    (m) =>
      m.active &&
      m.kind === "human" &&
      credentials.credentialFor(m.id) !== undefined,
  );
}

export type ApprovalAuthorityRefusal =
  | "self_approval"
  | "named_approver_required";

/**
 * Pure: may this approver approve this request? `approver` is the verified
 * member behind the session, or undefined when nobody was identified.
 */
export function checkApprovalAuthority(args: {
  preparedBy: string | undefined;
  approver: ActorSnapshot | undefined;
  requireNamedApprover: boolean;
}): { ok: true } | { ok: false; refusal: ApprovalAuthorityRefusal } {
  const { preparedBy, approver, requireNamedApprover } = args;
  if (approver && preparedBy !== undefined && approver.id === preparedBy) {
    return { ok: false, refusal: "self_approval" };
  }
  if (requireNamedApprover && !approver) {
    return { ok: false, refusal: "named_approver_required" };
  }
  return { ok: true };
}

/** What the person trying to approve is told. */
export function describeApprovalAuthorityRefusal(
  refusal: ApprovalAuthorityRefusal,
): string {
  switch (refusal) {
    case "self_approval":
      return "You started this run, so another member must approve this step.";
    case "named_approver_required":
      return "This workspace requires approvals from a signed-in member. Sign in with your own login to approve; the shared password and phone buttons cannot approve here.";
  }
}
