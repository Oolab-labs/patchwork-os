/**
 * The roster as the session gate sees it.
 *
 * `middleware.ts` must answer, for every request carrying a v2 cookie, whether
 * the member it names is still active. That is a file read of `members.json`
 * on the hot path, so it is cached — but for SECONDS, not for the process
 * lifetime. `memberAuth.ts` memoises the roster once per module instance
 * because it answers a login, where "rotation takes a restart" is acceptable.
 * This answers REVOCATION, and a revocation that waits for a restart is not
 * one: the whole reason the check exists is that deactivating a member used
 * to change nothing until the cookie expired.
 *
 * Five seconds is the deliberate compromise: cheap enough to run on every
 * request, short enough that "I deactivated them" is true within the time it
 * takes to say it. The bridge's attribution resolver re-reads per approval
 * (`approverFromSession.ts`), so a short TTL here is the more conservative of
 * the two existing stances, not a new one.
 *
 * Needs the Node runtime (`node:fs` via `loadRoster`); `middleware.ts` opts
 * into it with `config.runtime`.
 */

import { loadRoster, type Roster } from "../../../src/identity/roster";

const TTL_MS = 5_000;

let cached: { roster: Roster; readAt: number } | null = null;

export function sessionRoster(now = Date.now()): Roster {
  if (cached && now - cached.readAt < TTL_MS) return cached.roster;
  const roster = loadRoster();
  cached = { roster, readAt: now };
  return roster;
}

/** Tests only — the TTL otherwise hides a roster rewrite for up to 5 s. */
export function _resetSessionRosterCacheForTests(): void {
  cached = null;
}
