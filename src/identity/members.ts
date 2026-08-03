/**
 * Workspace members — the humans and workers a decision can be attributed to.
 *
 * Companion to `roles.ts`. This module owns the member record itself, the
 * authorisation question ("may this member do X?"), and the segregation-of-duties
 * question ("may this member approve THAT?"). Still no I/O: loading a roster
 * from disk and resolving a request to a member is `principal.ts`.
 *
 * Humans and workers are the same kind of record on purpose. Trust is already
 * keyed `(worker × actionClass)` in `src/workers/`, which is a per-member scope
 * by another name, and a workspace whose roster shows both is the honest
 * picture of who can act in it. The `kind` field exists so a policy can still
 * say "a human must approve this" without two parallel member models.
 */

import { type Capability, isRole, type Role, roleGrants } from "./roles.js";

/** Human or non-human. Kept explicit so policy can require a human approver. */
export type MemberKind = "human" | "worker";

export interface Member {
  /** Stable identifier. Appears verbatim in decision records — never reuse one. */
  id: string;
  /** What to show a person. Not an identifier. */
  displayName: string;
  kind: MemberKind;
  /** A set, not one value — see the note in roles.ts. */
  roles: Role[];
  /** Optional; only meaningful for humans, and only for display/invite. */
  email?: string;
  /**
   * When false the member keeps their record and history but may do nothing.
   * Deactivating rather than deleting is deliberate: deleting a member would
   * orphan every decision that names them, which is the opposite of what an
   * audit record is for.
   */
  active: boolean;
}

/** Whether this member may do `capability` at all. */
export function memberCan(member: Member, capability: Capability): boolean {
  if (!member.active) return false;
  return roleGrants(member.roles, capability);
}

/** Why an approval was refused, when it was. */
export type ApprovalRefusal =
  /** The member holds no role granting `action.approve`. */
  | "not_an_approver"
  /** The member's record is deactivated. */
  | "inactive"
  /** The member is the party that prepared the action. */
  | "self_approval"
  /** Policy required a human and the approver is a worker. */
  | "worker_cannot_approve_this";

export interface ApprovalCheck {
  allowed: boolean;
  refusal?: ApprovalRefusal;
}

/**
 * May `approver` approve an action prepared by `preparedById`?
 *
 * This is the segregation-of-duties rule, and the reason the whole identity
 * model exists: it is unanswerable while every request resolves to one shared
 * token, because every actor looks like the same actor.
 *
 * The self-approval check runs BEFORE the capability check so the refusal
 * reason is the true one. An owner holds `action.approve`, so testing
 * capability first would report an owner approving their own work as allowed.
 *
 * @param approver     The member attempting to approve.
 * @param preparedById The member id that prepared the action. When unknown,
 *                     pass `undefined` — the check then falls back to
 *                     capability alone. Callers should treat an unknown
 *                     preparer as a gap to close, not a normal state.
 * @param opts.requireHuman When true, a worker may never approve regardless of
 *                     its roles. Use for anything irreversible.
 */
export function canApproveAction(
  approver: Member,
  preparedById: string | undefined,
  opts: { requireHuman?: boolean } = {},
): ApprovalCheck {
  if (!approver.active) return { allowed: false, refusal: "inactive" };
  if (preparedById !== undefined && preparedById === approver.id) {
    return { allowed: false, refusal: "self_approval" };
  }
  if (opts.requireHuman && approver.kind !== "human") {
    return { allowed: false, refusal: "worker_cannot_approve_this" };
  }
  if (!roleGrants(approver.roles, "action.approve")) {
    return { allowed: false, refusal: "not_an_approver" };
  }
  return { allowed: true };
}

/** Human-readable form of a refusal, for a receipt or an approval screen. */
export function describeRefusal(refusal: ApprovalRefusal): string {
  switch (refusal) {
    case "self_approval":
      return "the same party prepared this action";
    case "not_an_approver":
      return "this member holds no approving role";
    case "inactive":
      return "this member is deactivated";
    case "worker_cannot_approve_this":
      return "this action requires a human approver";
  }
}

/**
 * Validate one untrusted roster entry.
 *
 * Returns null rather than throwing: a roster is operator-edited, and one
 * malformed entry must not take the whole workspace's membership with it. The
 * caller reports what it dropped.
 */
export function parseMember(input: unknown): Member | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;

  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;

  const kind: MemberKind = o.kind === "worker" ? "worker" : "human";

  const roles = Array.isArray(o.roles) ? o.roles.filter(isRole) : [];
  // A member with no recognised role can do nothing, which reads as a silent
  // lockout rather than a configuration error. Refuse the entry instead.
  if (roles.length === 0) return null;

  const displayName =
    typeof o.displayName === "string" && o.displayName.trim() !== ""
      ? o.displayName.trim()
      : id;

  const email =
    typeof o.email === "string" && o.email.trim() !== ""
      ? o.email.trim()
      : undefined;

  return {
    id,
    displayName,
    kind,
    roles: [...new Set(roles)],
    ...(email ? { email } : {}),
    // Absent means active. Only an explicit `false` deactivates, so a roster
    // written before this field existed keeps working.
    active: o.active !== false,
  };
}
