/**
 * toolPolicyCheck — the `patchwork.policy.yml` check for one in-process tool
 * call, shared by every site that dispatches one.
 *
 * Recipe and worker tool calls dispatch in-process via toolRegistry.executeTool
 * and NEVER pass through McpTransport, so the bridge's CLI/HTTP chokepoint
 * (bridge.ts / streamableHttp.ts) never sees them. That makes the sites that
 * call executeTool the only policy enforcement points: `executeStep` for a
 * normal step, and `fan_out` for each of its children, which used to be
 * checked against `fan_out` and its step params instead of the child tool and
 * the params it is actually called with.
 *
 * Runs whenever `policyEnforcementEnabled` holds (governed, or FLAG_ENFORCE_POLICY
 * under compat), independent of whether a worker owns
 * the recipe: `checkPolicy`'s base rules (forbiddenPaths / allowedNetworkHosts
 * / allowedCommands) apply to every tool call regardless of workerId; only its
 * 4th check (per-worker allowedTools) needs one, and that check no-ops when
 * workerId is undefined. Deny is fail-closed on a malformed policy file.
 */

import { policyEnforcementEnabled } from "../governance/policyEnforcement.js";
import { activeProfile } from "../governance/profile.js";
import { checkPolicy, loadPolicyFile } from "../policy.js";

/** Throws a `policy_denied`-coded Error when the policy refuses the call. */
export function enforceToolPolicy(
  toolId: string,
  params: Record<string, unknown>,
  deps: { workdir: string; workerId?: string },
): void {
  if (!policyEnforcementEnabled(activeProfile())) return;
  const loaded = loadPolicyFile(deps.workdir);
  if (!loaded.ok) {
    const err = new Error(`policy_denied: ${loaded.error}`);
    (err as Error & { code?: string }).code = "policy_denied";
    throw err;
  }
  const verdict = checkPolicy(loaded.policy, {
    toolName: toolId,
    params,
    ...(deps.workerId !== undefined && { workerId: deps.workerId }),
  });
  if (!verdict.allowed) {
    const err = new Error(`policy_denied: ${verdict.reason}`);
    (err as Error & { code?: string }).code = "policy_denied";
    throw err;
  }
}
