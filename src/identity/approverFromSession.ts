/**
 * Who approved this? — ADR-0020 Phase A, the last mile.
 *
 * `recipeOrchestration.ts` has carried this comment on the `gate` branch since
 * ADR-0017: *"the approving human is not known here, and cannot be until the
 * approval path carries an identity"*. This module is that identity, and the
 * evidence standard it holds to is the whole point.
 *
 * ## The cookie IS the evidence — nothing here re-asserts it
 *
 * The dashboard reaches the bridge through a proxy authenticated with the
 * SHARED bridge token. The cheap design has the dashboard send
 * `X-Patchwork-Member: ada` and the bridge believe it because the dashboard
 * held the bridge token. That was rejected: the record would say Ada approved
 * something on the evidence that somebody knew a shared secret, which is
 * precisely the standard the login route refuses when it declines to satisfy a
 * member-shaped login with `DASHBOARD_PASSWORD`. Attribution built on a shared
 * secret is not attribution.
 *
 * Instead the bridge verifies the v2 session cookie — the artifact the
 * member's OWN authentication produced. The dashboard cannot fabricate one
 * without `DASHBOARD_SESSION_SECRET`, so holding the bridge token is not
 * sufficient to name a person. Same format, one implementation, verified here
 * rather than trusted (`dashboardSession.ts`).
 *
 * ## Every failure yields `undefined`, and that is the correct answer
 *
 * No cookie, a v1 (unattributed) cookie, a bad signature, an expired one, a
 * member who left the roster, a deactivated member — all `undefined`, meaning
 * the decision record gets NO actor. An absent actor already means "nobody
 * recorded this" and is never backfilled (ADR-0017); a defaulted one is
 * indistinguishable from a recorded one. There is deliberately no fallback to
 * the implicit owner anywhere in this file.
 *
 * The most common `undefined` is the plainest: the bridge has never been given
 * `DASHBOARD_SESSION_SECRET` — `patchwork init` writes it only into the
 * dashboard's env — so on an unchanged install `verifySession` rejects
 * everything and nothing is attributed. That is a working deployment, not a
 * broken one: attribution is opt-in, and it switches on when an operator gives
 * both processes the same secret.
 */

import { verifySession } from "./dashboardSession.js";
import type { Member } from "./members.js";
import { findMember, loadRoster, type Roster } from "./roster.js";

/** The snapshot shape a decision record stores — id + kind + name AS IT WAS. */
export interface ActorSnapshot {
  id: string;
  kind: Member["kind"];
  displayName: string;
}

export interface ApproverResolverOpts {
  /**
   * Roster source. Injected for tests and so the caller can reuse the roster
   * the bridge already loaded at startup rather than re-reading the file on
   * every approval.
   */
  rosterFor?: () => Roster;
}

/**
 * Resolve the human behind a forwarded dashboard session cookie.
 *
 * Returns `undefined` for every failure — see the module header. Never throws:
 * a decision must not be blocked because attribution could not be established,
 * and a throw here would turn "we do not know who approved this" into "the
 * approval failed".
 */
export function createApproverResolver(
  opts: ApproverResolverOpts = {},
): (sessionCookie?: string) => Promise<ActorSnapshot | undefined> {
  const rosterFor = opts.rosterFor ?? (() => loadRoster());

  return async (sessionCookie?: string) => {
    if (!sessionCookie) return undefined;
    try {
      const { valid, memberId } = await verifySession(sessionCookie);
      // A valid v1 cookie has no memberId. Valid, and nobody — the session is
      // real but the shared password produced it, so there is no person to
      // name. This is the branch a `?? implicitOwner()` would ruin.
      if (!valid || !memberId) return undefined;

      const roster = rosterFor();

      // An IMPLICIT roster means no members.json exists — the single-owner
      // degraded default. A cookie naming a member cannot be honoured against
      // a roster that was synthesised rather than read: `findMember` would
      // match only the literal id `local-owner`, and attributing to an owner
      // nobody configured is exactly the defaulting this ADR forbids.
      if (roster.implicit) return undefined;

      const member = findMember(roster, memberId);
      // Gone from the roster, or deactivated. A deactivated member keeps their
      // history and may do nothing — including approve.
      if (!member?.active) return undefined;

      return {
        id: member.id,
        kind: member.kind,
        displayName: member.displayName,
      };
    } catch {
      // Unreadable roster, crypto failure, anything. Unattributed, never a
      // thrown approval.
      return undefined;
    }
  };
}
