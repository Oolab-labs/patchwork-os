/**
 * The authentication seam — ADR-0020 Phase A, and the valuable half.
 *
 * One interface that answers "who is making this request?", with Phase A
 * (local scrypt credentials against `members.json`) behind it today and Phase
 * B (OIDC, mapped on `sub`) able to slot in later WITHOUT changing any
 * consumer.
 *
 * Phase B is built in `patchwork-control-plane`, not here — ADR-0019 reserves
 * organisation identity for the non-MIT repo, and the two ADRs were written in
 * the same commit with this collision unexamined. The seam, `UNATTRIBUTED` and
 * the fail-soft roster default are MIT and live here. Federation does not.
 *
 * ## UNATTRIBUTED is a value, not an absence
 *
 * The single most important rule in this file, and the one a reasonable
 * implementation gets wrong: when nobody has authenticated, the answer is
 * `UNATTRIBUTED` — never the implicit owner.
 *
 * The roster fails SOFT: a missing `members.json` yields one implicit owner so
 * a single-user machine keeps working. That is right for "who may act on your
 * own machine". It is catastrophic for "who did this", because defaulting an
 * actor to the implicit owner writes a claim about a real person into an audit
 * record on no evidence. An absent `actor` already means "nobody recorded
 * this" and is never backfilled; a defaulted one is indistinguishable from a
 * recorded one and is a lie the record cannot walk back.
 *
 * So `resolveActor` returns `UNATTRIBUTED` and callers must handle it. There
 * is deliberately no `?? implicitOwner()` anywhere in this module, and a test
 * asserts the string never appears.
 */

import { verifyPassword } from "./credentials.js";
import type { Member } from "./members.js";
import { findMember, type Roster } from "./roster.js";

/**
 * Nobody authenticated. Distinct from "authentication failed" only in that
 * neither may ever be turned into a person.
 */
export const UNATTRIBUTED = "unattributed" as const;

export type Principal =
  | { kind: "member"; member: Member; via: string }
  | { kind: typeof UNATTRIBUTED };

/** Credentials presented by a caller. Extended, never replaced, by Phase B. */
export interface Presented {
  memberId?: string;
  password?: string;
}

/**
 * One authentication method. Phase A is `LocalPasswordProvider` below; Phase B
 * would add an OIDC provider behind this same shape.
 *
 * Returning `null` means "not my business" — no credentials of my kind were
 * presented. Returning `UNATTRIBUTED` means "mine were, and they were wrong".
 * The distinction matters: the first lets another provider try, the second
 * must not.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(presented: Presented, roster: Roster): Promise<Principal | null>;
}

/** Phase A: member id + password, verified against the stored scrypt record. */
export class LocalPasswordProvider implements AuthProvider {
  readonly name = "local-password";

  /**
   * `credentialFor` is injected rather than read from the Member type, because
   * where a hash is STORED is a separate decision from how it is verified —
   * and putting a password hash on the in-memory `Member` that decision
   * records copy from is how a hash ends up in an audit log.
   */
  constructor(
    private readonly credentialFor: (memberId: string) => string | undefined,
  ) {}

  async authenticate(
    presented: Presented,
    roster: Roster,
  ): Promise<Principal | null> {
    const { memberId, password } = presented;
    if (!memberId || !password) return null; // not our business

    const member = findMember(roster, memberId);
    const record = this.credentialFor(memberId);

    // Both branches do the same work whether or not the member exists, so
    // "no such member" and "wrong password" cost the same. Otherwise the
    // response time enumerates the roster.
    const stored = record ?? DUMMY_RECORD;
    const ok = await verifyPassword(password, stored);

    if (!ok || !member || !member.active || !record) {
      // A deactivated member keeps their record and history and may do
      // nothing — including authenticate.
      return { kind: UNATTRIBUTED };
    }
    return { kind: "member", member, via: this.name };
  }
}

/**
 * A syntactically valid record no password verifies against, so the unknown-
 * member path performs a real scrypt derivation instead of returning early.
 * The salt and hash are fixed and meaningless; the point is the CPU time.
 */
const DUMMY_RECORD =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Try each provider in order; the first that claims the request decides.
 *
 * With no providers, or none claiming it, the answer is `UNATTRIBUTED`. That
 * is the byte-identical status quo for a single-user machine with no
 * credentials configured: nothing is denied here, because this module answers
 * WHO, not WHETHER.
 */
export async function resolveActor(
  presented: Presented,
  roster: Roster,
  providers: readonly AuthProvider[],
): Promise<Principal> {
  for (const p of providers) {
    const result = await p.authenticate(presented, roster);
    if (result !== null) return result;
  }
  return { kind: UNATTRIBUTED };
}

/**
 * The actor snapshot to stamp on a decision record, or undefined.
 *
 * Undefined, NOT a placeholder person. Decision records store the actor as a
 * snapshot (id + kind + display name as it was) so a later rename cannot
 * rewrite history; absence stays absence.
 */
export function actorSnapshot(
  principal: Principal,
): { id: string; kind: Member["kind"]; displayName: string } | undefined {
  if (principal.kind === UNATTRIBUTED) return undefined;
  const { id, kind, displayName } = principal.member;
  return { id, kind, displayName };
}
