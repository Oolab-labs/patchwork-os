/**
 * The dashboard's adapter onto the identity seam — ADR-0020 Phase A, wiring.
 *
 * #1424 built `resolveActor`, #1425 built the v2 (attributed) session cookie
 * and #1428 built the credential store. Nothing called any of them. The login
 * route authenticated a SECRET, so it minted v1 and no record could name a
 * person: three pieces of infrastructure that were finished and inert, which
 * is the state in which infrastructure rots without anyone noticing.
 *
 * This module is the whole of the adapter. It answers exactly one question —
 * "does this member id plus password authenticate?" — and hands back an id
 * safe to put in a cookie. It decides no authorisation and reads no request.
 *
 * ## Read once, like the roster and the credential file
 *
 * Both stores document a load-once-at-startup contract: a file re-read per
 * request is a file whose contents and permissions change under a running
 * process, and the resulting behaviour is untestable. Next.js gives us no
 * startup hook, so "once" means once per module instance, memoised below.
 * Rotation takes a restart — the same as the bridge.
 *
 * ## An id that cannot be attributed is a REFUSAL, not a downgrade
 *
 * `parseMember` accepts any non-empty id. The v2 cookie payload is
 * dot-delimited, so `signSession` refuses an id containing a "." — two members
 * could otherwise mint cookies that parse as each other.
 *
 * The tempting fallback is to mint a v1 (unattributed) cookie for such a
 * member. That is the one thing this module must not do. The operator typed a
 * name and a password and would be logged in; every record produced by that
 * session would say nobody was identified. It is not a lie in the record — v1
 * honestly means unattributed — but it is a silent downgrade of exactly the
 * property this whole ADR exists to establish, and nothing anywhere would
 * report it. So the result is `unattributable`, the login fails, and the
 * operator is told to change the id.
 */

import {
  LocalPasswordProvider,
  resolveActor,
  UNATTRIBUTED,
} from "../../../src/identity/authSeam";
import { loadCredentials } from "../../../src/identity/credentialStore";
import { loadRoster, type Roster } from "../../../src/identity/roster";

/**
 * Ids that survive the dot-delimited v2 cookie payload.
 *
 * Deliberately a duplicate of `MEMBER_ID_RE` in `lib/session.ts` rather than an
 * import: that constant is a property of the COOKIE FORMAT and is enforced at
 * signing and verification, which is where it must live. This one is a
 * pre-flight check so a bad id produces a diagnosable refusal instead of a
 * thrown 500 out of `signSession`. Two checks of the same shape at two layers
 * is the intent — if they ever disagree, signing still refuses, and the
 * failure is loud rather than a forged cookie.
 */
const ATTRIBUTABLE_ID = /^[A-Za-z0-9_-]+$/;

export type MemberAuthResult =
  | { ok: true; memberId: string; displayName: string }
  | { ok: false; reason: "rejected" }
  | { ok: false; reason: "unattributable"; memberId: string };

interface Stores {
  roster: Roster;
  credentialFor: (memberId: string) => string | undefined;
  /** True when at least one member has a usable credential on disk. */
  anyCredentials: boolean;
}

let cached: Stores | null = null;

function stores(): Stores {
  if (cached) return cached;
  const roster = loadRoster();
  const creds = loadCredentials();
  cached = {
    roster,
    credentialFor: (id) => creds.credentialFor(id),
    anyCredentials: creds.ids().length > 0,
  };
  return cached;
}

/** Test seam. Production never calls this. */
export function __resetMemberAuthCacheForTest(): void {
  cached = null;
}

/**
 * Is per-member login available on this deployment at all?
 *
 * Used to decide whether a member-shaped login attempt is a real possibility
 * or a misconfiguration worth naming. NOT used to skip the credential check:
 * the check runs regardless, so "no credentials configured" and "wrong
 * password" cost the same and neither enumerates anything.
 */
export function memberLoginConfigured(): boolean {
  return stores().anyCredentials;
}

/**
 * Authenticate a member. `rejected` covers every failure the caller may
 * distinguish: unknown member, deactivated member, no credential on file,
 * wrong password. They are one outcome ON PURPOSE — telling them apart tells
 * an attacker which member ids exist.
 */
export async function authenticateMember(
  memberId: string,
  password: string,
): Promise<MemberAuthResult> {
  const { roster, credentialFor } = stores();
  const principal = await resolveActor({ memberId, password }, roster, [
    new LocalPasswordProvider(credentialFor),
  ]);
  if (principal.kind === UNATTRIBUTED) return { ok: false, reason: "rejected" };

  const { id, displayName } = principal.member;
  if (!ATTRIBUTABLE_ID.test(id)) {
    return { ok: false, reason: "unattributable", memberId: id };
  }
  return { ok: true, memberId: id, displayName };
}
