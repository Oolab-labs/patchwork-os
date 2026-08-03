/**
 * Workspace roles and what each one may do.
 *
 * The bridge has authenticated a single bearer token since it was written, so
 * every record it has ever produced names a token, not a person —
 * `GateDecisionRecord` carries `workerId` (the non-human actor) and nothing
 * else. That makes "who allowed this?" unanswerable, and segregation of duties
 * (the party that prepared an action must not be the party that approves it)
 * unenforceable rather than merely unimplemented. See
 * [ADR-0017](../../docs/adr/0017-decision-record-actor-and-forbid.md).
 *
 * This module is the leaf: pure role/capability logic with no I/O, no config
 * and no transport dependency, so it can be reasoned about and tested on its
 * own. Nothing here is wired into request handling yet — resolving a request to
 * a member is `principal.ts`, and threading an actor onto persisted records is
 * a later step.
 *
 * Two deliberate shapes:
 *
 *  - **A member holds a SET of roles, not one.** The alternative forces a
 *    single-admin workspace to choose between administering and approving, and
 *    the usual workaround is to quietly grant `admin` the approve capability —
 *    which destroys the separation the roles exist to express.
 *  - **Capabilities are coarse.** Nine of them, not fifty. A permission model
 *    nobody can hold in their head gets bypassed, and the audience for this one
 *    includes a controller and a security reviewer, not only an engineer.
 */

/** Who a member is, in terms of what the workspace lets them do. */
export type Role =
  | "owner"
  | "admin"
  | "operator"
  | "approver"
  | "auditor"
  | "worker";

export const ROLES: readonly Role[] = [
  "owner",
  "admin",
  "operator",
  "approver",
  "auditor",
  "worker",
] as const;

/**
 * What a member may do. Deliberately coarse — these name outcomes a human
 * would recognise, not individual endpoints.
 */
export type Capability =
  /** See the workspace's records: cases, actions, decisions. */
  | "workspace.read"
  /** See the audit record itself — evidence, receipts, decision history. */
  | "evidence.read"
  /** Start work: open a case, run a recipe, investigate. */
  | "work.run"
  /** Prepare an action and submit it for approval. Never applies it. */
  | "action.propose"
  /** Allow someone else's proposed action to proceed. */
  | "action.approve"
  /** Add, remove and re-role members. */
  | "members.manage"
  /** Change what the workspace permits — limits, ceilings, forbidden actions. */
  | "policy.manage"
  /** Connect and disconnect external systems, and hold their credentials. */
  | "systems.manage"
  /** Plan, payment method, invoices. */
  | "billing.manage";

const ALL: readonly Capability[] = [
  "workspace.read",
  "evidence.read",
  "work.run",
  "action.propose",
  "action.approve",
  "members.manage",
  "policy.manage",
  "systems.manage",
  "billing.manage",
];

/**
 * Role → capabilities.
 *
 * Notes on the non-obvious entries:
 *
 *  - `admin` does NOT get `action.approve`. Administering the workspace and
 *    approving work inside it are different authorities; someone who needs both
 *    is given both roles, visibly, rather than one role quietly meaning two.
 *  - `auditor` gets reads and nothing else. This is the point of the role —
 *    it is the cheapest artifact to hand a security reviewer, and it is only
 *    worth anything if it is provably incapable of changing something.
 *  - `worker` (non-human) may run and propose, never approve, and does not get
 *    `evidence.read`: a worker needs the evidence for its own case, which is
 *    scoped to that case, not standing access to the audit record.
 */
const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  owner: ALL,
  admin: [
    "workspace.read",
    "evidence.read",
    "work.run",
    "action.propose",
    "members.manage",
    "policy.manage",
    "systems.manage",
  ],
  operator: ["workspace.read", "evidence.read", "work.run", "action.propose"],
  approver: ["workspace.read", "evidence.read", "action.approve"],
  auditor: ["workspace.read", "evidence.read"],
  worker: ["work.run", "action.propose"],
};

/** Every capability the given roles confer, deduplicated. */
export function capabilitiesFor(roles: readonly Role[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const role of roles) {
    for (const cap of ROLE_CAPABILITIES[role] ?? []) out.add(cap);
  }
  return out;
}

/** Whether any of `roles` confers `capability`. */
export function roleGrants(
  roles: readonly Role[],
  capability: Capability,
): boolean {
  return roles.some((r) => (ROLE_CAPABILITIES[r] ?? []).includes(capability));
}

/** Narrow an untrusted string to a Role. */
export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}
