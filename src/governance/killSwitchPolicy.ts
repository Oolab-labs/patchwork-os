/**
 * Kill-switch read with a profile-dependent failure mode.
 *
 * Invariant the governed profile promises: if the kill switch is active, no
 * Patchwork-mediated consequential write occurs. A read that FAILS cannot be
 * allowed to resolve to "released" under that promise — an unreadable flags
 * state is exactly what tampering with `flags.json` or the install would
 * produce. Under `compat` the historical fail-open stays, because that is
 * what every existing call site did and this module exists to replace those
 * sites without changing what they do for existing installs.
 *
 * Every dispatch chokepoint (recipe `executeTool`, MCP `transport.ts`,
 * subprocess spawn, orchestrator enqueue, recipe entry) calls
 * `readKillSwitch()` / `assertKillSwitchReleased()` rather than importing
 * `isWriteKillSwitchActive` and wrapping it in its own `try {} catch {}` —
 * which is how four sites ended up fail-open with a comment saying "same as
 * every other site".
 */

import { isWriteKillSwitchActive } from "../featureFlags.js";
import { activeProfile, type GovernanceProfile } from "./profile.js";

export interface KillSwitchReading {
  /** True ⇒ refuse the write. */
  engaged: boolean;
  reason:
    | "engaged"
    | "released"
    | "unreadable_fail_closed"
    | "unreadable_fail_open";
}

let reader: () => boolean = isWriteKillSwitchActive;

export function readKillSwitch(
  profile: GovernanceProfile = activeProfile(),
): KillSwitchReading {
  try {
    const engaged = reader();
    return { engaged, reason: engaged ? "engaged" : "released" };
  } catch {
    if (profile.killSwitchFailClosed) {
      return { engaged: true, reason: "unreadable_fail_closed" };
    }
    return { engaged: false, reason: "unreadable_fail_open" };
  }
}

export function killSwitchMessage(
  r: KillSwitchReading,
  operation: string,
): string {
  return r.reason === "unreadable_fail_closed"
    ? `kill_switch_blocked: ${operation} refused — kill-switch state unreadable and the governed profile fails closed`
    : `kill_switch_blocked: ${operation} refused — write kill switch engaged. Release with \`patchwork kill-switch release\`.`;
}

/** Throw a coded error when the switch is engaged. Same code as `assertWriteAllowed`. */
export function assertKillSwitchReleased(
  operation: string,
  profile: GovernanceProfile = activeProfile(),
): void {
  const r = readKillSwitch(profile);
  if (r.engaged) {
    const err = new Error(killSwitchMessage(r, operation));
    (err as Error & { code?: string }).code = "kill_switch_blocked";
    throw err;
  }
}

/** Test seam: replace the underlying reader (e.g. with one that throws). */
export function _setKillSwitchReaderForTesting(
  fn: (() => boolean) | null,
): void {
  reader = fn ?? isWriteKillSwitchActive;
}
