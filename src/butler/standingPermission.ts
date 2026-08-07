/**
 * Standing permissions — "stop asking me about the small things".
 *
 * Every Butler design mockup has that button and nothing has ever been behind
 * it. This is the record behind it.
 *
 * ## What a standing permission IS
 *
 * A PRE-RECORDED HUMAN APPROVAL, scoped and revocable. Nothing more.
 *
 * That framing is the whole design, and it is worth being precise about
 * because the obvious alternative is wrong. The plan for this phase described
 * the permission as composing "as another `min()` alongside `autonomyCeiling`
 * and `contextCeiling`". It cannot: those are ceilings that LOWER autonomy,
 * and a standing permission by definition lets through something that would
 * otherwise have stopped. Wiring it into that seam would either do nothing or
 * would raise earned trust — and raising earned trust is the one thing it must
 * never do, because then an action a human waved through in advance becomes
 * evidence that the WORKER is reliable. That is trust-by-neglect with extra
 * steps, the same scoring leak `foldOutcome` was fixed for.
 *
 * So the trust maths is untouched. `decideWorkerAction` is byte-identical
 * whether or not any permission exists. A permission acts strictly later, at
 * the point where the gate has already said "ask a human" — and it answers on
 * that human's behalf, because they said so in advance and in writing.
 *
 * ## The four rules, and where each is enforced
 *
 * 1. **It only ever narrows.** A grant applies to the classes its `scope`
 *    names and nothing else, and only a `queue` outcome is convertible —
 *    `refuse` passes through untouched, so no grant can ever unlock a
 *    forbidden action. Enforced structurally in `resolveGateOutcome`: the
 *    conversion is only reachable from the queue branch.
 * 2. **Never covers `irreversible`.** The UI copy promises "anything you can
 *    undo"; `coversAction` refuses irreversible outright, ahead of every other
 *    check, so no combination of scope and ceiling can reach it.
 * 3. **Revocation is immediate, and the record is kept.** `revokedAt` makes a
 *    grant inert on the very next decision. The row is never deleted — a
 *    revoked grant must stay auditable, because "this was allowed for three
 *    weeks and then withdrawn" is exactly the question an audit asks.
 * 4. **Every use is reported.** The caller records an exercise on each
 *    conversion. A permission whose exercises are invisible is indistinguishable
 *    from a bug, and the page has to be able to say "done without asking,
 *    because you allowed it".
 *
 * This module is PURE — no I/O, no clock of its own. `permissionStore.ts` holds
 * the durable side.
 */

import type { ActionClass, MagnitudeBand } from "../workers/actionClass.js";

/**
 * A grant. Append-only: a correction is a new row, a revocation sets
 * `revokedAt` on a new row carrying the same `id` (see `permissionStore.ts`).
 */
export interface StandingPermission {
  id: string;
  grantedAt: number;
  /**
   * Who granted it. NEVER defaulted to the implicit owner (ADR-0020): the
   * bridge authenticates one shared token, so an unauthenticated principal is
   * `null`, meaning "unattributed". Writing a real person's name onto a
   * permission they may not have granted is worse than an absent one, and this
   * record is precisely the kind an audit would rely on.
   */
  grantedBy: string | null;
  /**
   * What it covers. Matches `WorkerManifest.owns` syntax deliberately — domain
   * (`"tasks"`), exact class key (`"issue:compensable:high"`), or prefix
   * (`"issue:compensable"`). Reusing the syntax means an operator learns one
   * pattern language, and a grant can be read against a worker's `owns`
   * without translation.
   */
  scope: { domains: string[] };
  ceiling?: {
    /** Widest magnitude band this grant reaches, for value-bearing domains. */
    magnitudeBand?: MagnitudeBand;
    /** Maximum exercises per calendar day. */
    perDay?: number;
  };
  /** Absent = until revoked. */
  expiresAt?: number;
  /** Set on revocation. The grant stays in the log, inert. */
  revokedAt?: number;
  /** Free text shown back to the user ("small errands, nothing costly"). */
  note?: string;
}

/** Band ordering. `band>500` is the widest, and also where an UNREADABLE
 *  amount lands (`magnitudeBandFor`) — so a malformed param can never sneak
 *  under a narrow ceiling. */
const BAND_ORDER: Record<MagnitudeBand, number> = {
  "band<=50": 0,
  "band<=500": 1,
  "band>500": 2,
};

/** The subset of a gate decision the matcher needs. Kept structural rather
 *  than importing `WorkerGateDecision` so this module stays independent of the
 *  gate's shape and can be tested on plain objects. */
export interface PermissionSubject {
  domain: string;
  classKey: string;
  reversibility: ActionClass["reversibility"];
  magnitudeBand?: MagnitudeBand;
}

export type PermissionCheck =
  | { covered: true; permission: StandingPermission; reason: string }
  | { covered: false; reason: string };

/** Is this grant live at `now`? Revocation beats expiry beats not-yet-granted. */
export function isActive(p: StandingPermission, now: number): boolean {
  if (p.revokedAt !== undefined && p.revokedAt <= now) return false;
  if (p.expiresAt !== undefined && p.expiresAt <= now) return false;
  return p.grantedAt <= now;
}

/** Same pattern language as `ownsAction`: domain, exact key, or prefix. */
function scopeMatches(
  p: StandingPermission,
  subject: PermissionSubject,
): boolean {
  return p.scope.domains.some(
    (d) =>
      d === subject.domain ||
      d === subject.classKey ||
      subject.classKey.startsWith(`${d}:`),
  );
}

export interface CoverageOpts {
  now: number;
  /** Exercises already recorded today for a given grant. Absent ⇒ 0, which is
   *  the permissive direction — so a caller that CAN count must pass this, and
   *  `perDay` without a counter is documented as unenforced rather than
   *  silently enforced-at-zero. */
  usageToday?: (permissionId: string) => number;
}

/**
 * Does any live grant cover this action?
 *
 * Returns the FIRST matching grant in the order supplied. Callers pass grants
 * newest-first; a narrower older grant losing to a broader newer one is fine
 * because both were authorised by the same person and coverage is a union.
 */
export function coversAction(
  permissions: readonly StandingPermission[],
  subject: PermissionSubject,
  opts: CoverageOpts,
): PermissionCheck {
  // Rule 2, first and unconditionally. No scope, ceiling or expiry combination
  // may reach an irreversible action — the copy promises "anything you can
  // undo" and this is where that promise is kept rather than described.
  if (subject.reversibility === "irreversible") {
    return {
      covered: false,
      reason:
        "irreversible actions are never covered by a standing permission — this one always needs a person",
    };
  }

  for (const p of permissions) {
    if (!isActive(p, opts.now)) continue;
    if (!scopeMatches(p, subject)) continue;

    const capBand = p.ceiling?.magnitudeBand;
    if (capBand !== undefined) {
      // A value-bearing action with no readable band cannot be shown to be
      // under the cap, so it is not covered. `magnitudeBandFor` already bands
      // an unreadable amount as the widest, but a subject arriving with no
      // band at all must not slip past a ceiling that exists.
      if (subject.magnitudeBand === undefined) continue;
      if (BAND_ORDER[subject.magnitudeBand] > BAND_ORDER[capBand]) continue;
    }

    const perDay = p.ceiling?.perDay;
    if (perDay !== undefined && opts.usageToday) {
      if (opts.usageToday(p.id) >= perDay) {
        return {
          covered: false,
          reason: `standing permission ${p.id} has reached its limit of ${perDay} today — asking a person instead`,
        };
      }
    }

    return {
      covered: true,
      permission: p,
      reason: `covered by a standing permission you granted${
        p.note ? ` (${p.note})` : ""
      }`,
    };
  }

  return { covered: false, reason: "no standing permission covers this" };
}
