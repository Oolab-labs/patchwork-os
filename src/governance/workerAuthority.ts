/**
 * Is the worker trust-ramp gate in force? — the ONE predicate.
 *
 * Three readers ask this: the runtime (`buildWorkerAutonomyGate` and
 * `buildWorkerAgentDisallowedTools` in `recipeOrchestration.ts`), `patchwork
 * doctor` (`doctorReport.ts`) and `patchwork policy explain`. They used to
 * answer it separately, and drifted: doctor and explain honoured
 * `profile.workerAuthority`, the runtime read only `FLAG_WORKER_AUTONOMY`. The
 * bridge flipped the flag in memory under `governed`, so they agreed only
 * until an operator's `PATCHWORK_FLAG_WORKER_AUTONOMY=0`, a `flags.json`
 * reload, or a process that publishes the profile without touching the flag
 * — after which doctor said ENFORCED while worker recipes ran ungated.
 *
 * Governed turns the gate ON regardless of the flag. Under compat the flag is
 * the only switch, exactly as before the profile existed.
 */

import { FLAG_WORKER_AUTONOMY, isEnabled } from "../featureFlags.js";
import type { GovernanceProfile } from "./profile.js";

export function workerGateEnabled(
  profile: Pick<GovernanceProfile, "workerAuthority">,
  isFlagOn: (flagId: string) => boolean = isEnabled,
): boolean {
  return profile.workerAuthority || isFlagOn(FLAG_WORKER_AUTONOMY);
}
