import { classifyTool, getRiskTierMap } from "../riskTier.js";
import {
  type ActionClass,
  classifyActionClass,
  knownActionTools,
} from "./actionClass.js";
import type { TrustLevel } from "./trustLevel.js";
import { ownsAction, type WorkerManifest } from "./worker.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";

/**
 * The LIVE worker-autonomy decision (worker-ramp-v0, phase 2). Unlike
 * `shadowGate.recommend` — which reports queue/bypass purely for the dial — this
 * is what the approval gate ACTS on when the `worker.autonomy` flag is enabled.
 *
 * The rule is reversibility-scoped, deliberately. Pure "gate everything the
 * worker hasn't earned L4 on" is correct-but-unusable: a brand-new worker would
 * halt on EVERY action for the weeks it takes to accumulate evidence (the
 * evidence-latency reality). Reversibility is the ramp's primary axis, so it is
 * the gate's too:
 *
 *   - REVERSIBLE actions flow un-gated regardless of earned level. They are
 *     undoable (transactions + WriteEffectLedger, git reset/reflog, re-runnable
 *     CI) so the cost of being wrong is bounded — undo it. Blast tier still
 *     drives the FAILURE WEIGHT, so a big reversible mistake demotes the worker
 *     hard; it just isn't pre-gated. This is the routine work (read, local
 *     commit, ledgered file write) a new worker should simply do.
 *   - COMPENSABLE / IRREVERSIBLE actions (lossy or no undo — remote push, PR,
 *     merge, outbound message, http POST, shell, delete) are gated for human
 *     approval until the worker has EARNED (ceiling-capped) L4 trust on that
 *     exact action-class. This is the "stop and ask before the dangerous thing"
 *     behaviour of a trustworthy new employee.
 *
 * The decision NEVER widens access on its own: when the flag is off the gate
 * path this feeds is not engaged at all, and even on, a "gate" result only ever
 * routes an action to the EXISTING human-approval queue (fail-closed) — it never
 * auto-approves anything that would otherwise have been queued by tier policy.
 */

export type WorkerGateAction = "allow" | "gate";

export interface WorkerGateDecision {
  action: WorkerGateAction;
  classKey: string;
  domain: string;
  owned: boolean;
  blastTier: ActionClass["blastTier"];
  reversibility: ActionClass["reversibility"];
  /** Trust actually earned on this class (for logging / the dial). */
  earnedLevel: TrustLevel;
  autonomyCeiling: TrustLevel;
  /** What the gate operates at: min(earned, ceiling), 0 if not owned. */
  effectiveLevel: TrustLevel;
  reason: string;
}

/**
 * Compensable actions (git-remote, issue) unlock autonomous execution at L2.
 * A compensating path exists (close the PR, delete the issue) so the cost of
 * an error is bounded — a worker at L2 has demonstrated enough reliability
 * that occasional human cleanup is acceptable. Irreversible actions (shell,
 * messaging, http) still require L4; they skip L2/L3 in the reachable-levels
 * set entirely, so this threshold never fires for them.
 */
const COMPENSABLE_AUTONOMY_LEVEL = 2 as const;

/** Irreversible actions (and unowned/unearned anything) require full L4. */
const AUTONOMOUS_LEVEL = 4 as const;

/** How the Claude subprocess sees bridge MCP tools under `--disallowed-tools`:
 *  `mcp__<server>__<tool>`. The server name is fixed to `patchwork` by the
 *  subprocess driver's writeMcpConfigFile, so the agent-step sandbox must block
 *  this form (not just the bare tool name) to actually deny a bridge MCP call. */
const BRIDGE_MCP_TOOL_PREFIX = "mcp__patchwork__";

/**
 * Undoable → flows un-gated even when unearned. Only reversible actions are
 * exempt from the trust requirement; compensable ones graduate to autonomous
 * at L2+; irreversible ones wait for earned L4.
 */
export function flowsUngated(ac: ActionClass): boolean {
  return ac.reversibility === "reversible";
}

export function decideWorkerAction(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
): WorkerGateDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;

  let effectiveLevel: TrustLevel = owned ? earnedLevel : 0;
  if (effectiveLevel > worker.autonomyCeiling)
    effectiveLevel = worker.autonomyCeiling;

  const base = {
    classKey: ac.key,
    domain: ac.domain,
    owned,
    blastTier: ac.blastTier,
    reversibility: ac.reversibility,
    earnedLevel,
    autonomyCeiling: worker.autonomyCeiling,
    effectiveLevel,
  } as const;

  // Agent (reasoning) steps are not a durable side-effecting action-class: the
  // claude subprocess produces an output var, and any tool calls it makes are
  // gated on their OWN class. The step id classifies as `other:irreversible`
  // (owned by no worker), so without this it would gate forever and stall every
  // worker on its agent step while the real file.write flowed. Let it through;
  // the downstream tool steps still gate. The tier gate (composed as a floor by
  // the caller) still applies its own policy to the agent step.
  if (toolName === "agent") {
    return {
      ...base,
      action: "allow",
      reason: "agent reasoning step — not a gated action-class",
    };
  }

  // Reversible: flows freely. The routine work a new worker should just do.
  if (flowsUngated(ac)) {
    return {
      ...base,
      action: "allow",
      reason: `reversible (${ac.blastTier} blast) — undoable, flows un-gated`,
    };
  }

  // Compensable: autonomous at L2+. A compensating action exists, so the cost
  // of being wrong is bounded. Workers earning L2 on vcs-remote or issue can
  // push and open issues without per-action approval.
  if (
    ac.reversibility === "compensable" &&
    effectiveLevel >= COMPENSABLE_AUTONOMY_LEVEL
  ) {
    return {
      ...base,
      action: "allow",
      reason: `earned autonomy (L${effectiveLevel}) on compensable class — auto-allowed at L${COMPENSABLE_AUTONOMY_LEVEL}+`,
    };
  }

  // Irreversible (and compensable still below L2): autonomous only at L4.
  if (effectiveLevel >= AUTONOMOUS_LEVEL) {
    return {
      ...base,
      action: "allow",
      reason: `earned autonomy (L4) on ${ac.reversibility} class`,
    };
  }

  const threshold =
    ac.reversibility === "compensable"
      ? COMPENSABLE_AUTONOMY_LEVEL
      : AUTONOMOUS_LEVEL;
  let reason: string;
  if (!owned) {
    reason = `${ac.reversibility} action outside the worker's owned domain — gated`;
  } else if (worker.autonomyCeiling < threshold) {
    reason = `${ac.reversibility} class capped by autonomy ceiling (L${worker.autonomyCeiling} < L${threshold}) — always gated`;
  } else {
    reason = `${ac.reversibility} + unearned (effective L${effectiveLevel} < L${threshold}) — gated for approval`;
  }
  return { ...base, action: "gate", reason };
}

/**
 * Tools a worker's AGENT step must be barred from calling.
 *
 * An `agent` step spawns a Claude subprocess whose INTERNAL tool calls bypass
 * the per-step worker gate (only recipe *steps* pass through `decideWorkerAction`
 * — tools the subprocess invokes itself never do). Without this, a worker could
 * do via its agent exactly the risky action (`gitPush`, `githubMergePR`,
 * `slackPostMessage`, `runCommand`, …) the gate would otherwise have queued for
 * approval. We re-apply the gate as a subprocess sandbox: every tool the worker
 * cannot currently run autonomously (`decideWorkerAction → "gate"`) is added to
 * the subprocess's `--disallowed-tools`.
 *
 * Honours the live trust state AND the autonomy ceiling (both fold into
 * `decideWorkerAction`'s `effectiveLevel = min(earned, ceiling)`): reversible
 * tools and risky tools the worker has EARNED stay callable; everything else is
 * blocked. The universe is the canonical tool registry (TIER_MAP keys); params
 * are unknown at sandbox-build time, so each tool is classified conservatively
 * with empty params.
 */
export function disallowedToolsForAgentStep(
  worker: WorkerManifest,
  store: WorkerLevelStore,
): string[] {
  // Universe = the canonical risk-tier map (broad MCP coverage) ∪ the worker
  // subsystem's own tool→domain map (adds messaging/http TIER_MAP omits).
  // Neither alone is complete; the union is the best enumerable approximation of
  // the risky tool surface.
  const universe = new Set([
    ...Object.keys(getRiskTierMap()),
    ...knownActionTools(),
  ]);
  const blocked = new Set<string>();
  for (const toolName of universe) {
    // The agent step itself is always allowed (reasoning, not a durable side-
    // effect — decideWorkerAction special-cases it); never self-block.
    if (toolName === "agent") continue;
    // Recipe-DSL ids (`github.create_issue`, `file.write`) are internal to the
    // recipe runner — the Claude subprocess never calls them by that name, so
    // they would be dead weight in `--disallowed-tools`. The camelCase MCP twin
    // (githubCreateIssue) is enumerated separately and IS emitted below.
    if (toolName.includes(".")) continue;
    if (
      decideWorkerAction(worker, toolName, undefined, store).action !== "gate"
    )
      continue;
    // Don't over-block. An UNKNOWN tool (domain "other") defaults to
    // irreversible in the trust model — conservative for EARNING, but blanket-
    // denying every unknown here would strip the agent of the harmless reads and
    // navigation it needs to do its job (getDiagnostics, searchWorkspace,
    // goToDefinition, getHover, … all classify as other:irreversible:low). Only
    // block an "other" tool when the registry rates it high-blast (e.g. Bash);
    // tools with a KNOWN risky domain (shell, messaging, http, vcs-push/merge,
    // issue) are always blocked. The recipe's explicit tool STEPS still gate on
    // their own class — this list is defense-in-depth, not the only gate.
    const ac = classifyActionClass(toolName);
    if (ac.domain === "other" && classifyTool(toolName) !== "high") continue;
    // Emit BOTH naming forms the subprocess might use: the bare name (native CC
    // tools like `Bash`, and any non-namespaced match) AND the bridge MCP form
    // `mcp__patchwork__<tool>` (how claude -p sees bridge tools under
    // --disallowed-tools; server name fixed by writeMcpConfigFile). A form that
    // matches nothing is harmless; missing one would leave the bypass open.
    blocked.add(toolName);
    blocked.add(`${BRIDGE_MCP_TOOL_PREFIX}${toolName}`);
  }
  return Array.from(blocked).sort();
}

/**
 * Union a step's own `disallowedTools` with the worker-ceiling-derived block
 * list. Returns `undefined` when both are empty so callers preserve the "field
 * absent" shape. When there is NO worker list (the non-worker case), the step's
 * list is returned VERBATIM — same value, same order, same duplicates — so a
 * non-worker agent step is byte-identical to pre-flip behaviour. Only an actual
 * merge dedups + sorts (argv order/dupes are inert for a deny SET).
 */
export function mergeAgentDisallowedTools(
  stepList?: string[],
  workerList?: string[],
): string[] | undefined {
  if (!workerList?.length) return stepList?.length ? stepList : undefined;
  if (!stepList?.length) return Array.from(new Set(workerList)).sort();
  return Array.from(new Set([...stepList, ...workerList])).sort();
}
