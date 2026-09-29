/**
 * Is `patchwork.policy.yml` enforced? — the ONE predicate.
 *
 * Four readers ask this: the recipe tool check (`recipes/toolPolicyCheck.ts`),
 * the WebSocket approval gate (`bridge.ts`), the HTTP approval gate
 * (`streamableHttp.ts`) and `patchwork doctor` (`doctorReport.ts`). The three
 * runtime sites read only `FLAG_ENFORCE_POLICY` while doctor honoured
 * `profile.policyEnforce`. The bridge flips the flag in memory under
 * `governed`, so they agreed only until an operator's
 * `PATCHWORK_FLAG_POLICY_ENFORCE=0`, a `flags.json` reload, or a process that
 * publishes the profile without the flag — after which doctor said ENFORCED
 * while a forbidden path was written. Same shape as `workerGateEnabled`.
 *
 * Governed turns enforcement ON regardless of the flag. Under compat the flag
 * is the only switch, exactly as before the profile existed.
 */

import { FLAG_ENFORCE_POLICY, isEnabled } from "../featureFlags.js";
import type { GovernanceProfile } from "./profile.js";

export function policyEnforcementEnabled(
  profile: Pick<GovernanceProfile, "policyEnforce">,
  isFlagOn: (flagId: string) => boolean = isEnabled,
): boolean {
  return profile.policyEnforce || isFlagOn(FLAG_ENFORCE_POLICY);
}
