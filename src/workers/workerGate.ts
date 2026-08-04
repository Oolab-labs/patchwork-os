import { classifyTool, getRiskTierMap } from "../riskTier.js";
import {
  type ActionClass,
  classifyActionClass,
  knownActionTools,
} from "./actionClass.js";
import { type ContextRisk, contextRiskCeiling } from "./contextRisk.js";
import {
  type ForbidRule,
  isForbidden,
  parseForbidRules,
} from "./forbidPolicy.js";
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

export type WorkerGateAction = "allow" | "gate" | "forbid";

/** What the caller should actually do with a gate decision. */
export type GateOutcome =
  /** Let it proceed (still subject to any tier gate composed above). */
  | "flow"
  /** Ask a human. */
  | "queue"
  /** Refuse outright — no human is asked, because none may say yes. */
  | "refuse";

/**
 * Map a gate action to what the caller does about it.
 *
 * Exists to make the third branch explicit *before* there is a third action.
 * The call site in `recipeOrchestration.ts` reads `if (action === "allow")
 * flow; else queue`, which is correct for exactly two values and becomes a
 * safety hole the moment a third exists: the `forbid` state
 * [ADR-0017](../../docs/adr/0017-decision-record-actor-and-forbid.md)
 * introduces would fall into the `else` and be OFFERED TO A HUMAN AS
 * APPROVABLE — and a human approving it would let through an action that no
 * approval may unlock.
 *
 * So the default is `refuse`, not `queue`. An action this build does not
 * understand is one it must not perform, and it must not recruit a human into
 * performing it either. That is the fail-closed direction, consistent with
 * [ADR-0016](../../docs/adr/0016-approval-hook-fail-closed.md).
 *
 * Latent today — only `"gate"` currently reaches the non-allow path — which is
 * precisely why it is cheap to fix now.
 */
export function gateOutcomeFor(action: string): GateOutcome {
  switch (action) {
    case "allow":
      return "flow";
    case "gate":
      return "queue";
    default:
      return "refuse";
  }
}

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
  /** What the gate operates at: min(earned, ceiling, contextCeiling), 0 if not
   *  owned. */
  effectiveLevel: TrustLevel;
  /** The descending ceiling imposed by live context-risk (4 = no de-rate).
   *  Present only when a contextRisk was supplied. Diagnostic / audit. */
  contextCeiling?: TrustLevel;
  reason: string;
}

/** Optional, descending-only signals that fold into the autonomy decision
 *  alongside earned trust (the keystone seam — see
 *  docs/worker-autonomy-policy-gate.md). All absent ⇒ byte-identical to the
 *  earned-trust-only gate. New signals may only LOWER autonomy, never raise it. */
export interface AutonomyDecisionOpts {
  /** Live situational risk for THIS action (fast, day-1, no cold-start). */
  contextRisk?: ContextRisk;
  /**
   * Actions this workspace forbids outright (ADR-0017). Absent or empty ⇒ no
   * action is forbidden and the decision is byte-identical to the pre-forbid
   * gate, so forbidding is entirely opt-in.
   */
  forbidRules?: readonly ForbidRule[];
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

/** The gate-policy version stamped on every persisted decision (the threshold
 *  constants + composition rule below). A decision can't be replayed/explained
 *  without knowing which policy produced it — bump when the thresholds or the
 *  reversibility→level mapping change. */
export const GATE_POLICY_VERSION = "worker-ramp-v1";

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

/**
 * The single decision point for the worker-autonomy gate: allow or gate one
 * tool call for one worker.
 *
 * Contract: `effectiveLevel = min(earnedLevel, worker.autonomyCeiling, contextCeiling)`,
 * where `contextCeiling` is computed from `opts.contextRisk` (undefined ⇒ no-op,
 * never widens). `contextCeiling` is **descending-only** — a live signal (red CI,
 * huge diff, hotspot file) may only lower the effective level below what earned
 * trust + the static ceiling would allow; it can never raise it above them. The
 * `min()` composition means every one of the three inputs acts strictly as a
 * ceiling, not a floor.
 *
 * Returns a `WorkerGateDecision` with `action: "allow" | "gate"` plus a
 * human-readable `reason` (and the classification/level fields from `base`)
 * explaining which constraint was binding. See
 * docs/worker-autonomy-policy-gate.md and `GATE_POLICY_VERSION` for the full
 * policy (thresholds, reversibility→level mapping) — this comment documents
 * the code contract only, not the policy rationale.
 */
export function decideWorkerAction(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
  opts?: AutonomyDecisionOpts,
): WorkerGateDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;

  let effectiveLevel: TrustLevel = owned ? earnedLevel : 0;
  if (effectiveLevel > worker.autonomyCeiling)
    effectiveLevel = worker.autonomyCeiling;

  // Descending context-risk clamp (keystone seam). A live, situational de-rater:
  // it can only LOWER the effective level (never-widen). Absent ⇒ no-op, so the
  // earned-trust-only path is byte-identical. A worker with a clean situation
  // keeps its earned autonomy; a dangerous live context (red CI, huge diff,
  // hotspot file) throttles it toward propose-only regardless of earned level.
  const contextCeiling: TrustLevel | undefined = opts?.contextRisk
    ? contextRiskCeiling(opts.contextRisk.score)
    : undefined;
  if (contextCeiling !== undefined && effectiveLevel > contextCeiling)
    effectiveLevel = contextCeiling;

  const base = {
    classKey: ac.key,
    domain: ac.domain,
    owned,
    blastTier: ac.blastTier,
    reversibility: ac.reversibility,
    earnedLevel,
    autonomyCeiling: worker.autonomyCeiling,
    effectiveLevel,
    ...(contextCeiling !== undefined && { contextCeiling }),
  } as const;

  // Forbidden actions are settled FIRST — before the agent carve-out, before
  // reversibility, before any trust maths. "Forbidden" means no earned trust
  // and no human approval unlocks this, so any branch that precedes it is a
  // path around it.
  //
  // That ordering is deliberate even though it makes a broad rule (say
  // `match: "other"`) capable of stalling every worker on its agent step. That
  // failure is loud and self-explaining: each decision names the rule that
  // fired. The alternative — letting a carve-out run first — fails silently, by
  // permitting an action the operator declared must never happen. A safety
  // control that a carve-out can bypass is not one.
  const forbidden = isForbidden(ac, opts?.forbidRules ?? []);
  if (forbidden.forbidden) {
    return {
      ...base,
      action: "forbid",
      reason: `forbidden by workspace policy (rule \`${forbidden.matchedBy}\`): ${forbidden.reason}`,
    };
  }

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
  // Context-risk is the BINDING constraint when it dropped the effective level
  // below what earned trust + ceiling alone would have allowed. Attribute it so
  // the audit trail shows the situation throttled the action, not stale trust.
  const earnedCapped = Math.min(
    owned ? earnedLevel : 0,
    worker.autonomyCeiling,
  );
  if (
    contextCeiling !== undefined &&
    contextCeiling < threshold &&
    contextCeiling < earnedCapped
  ) {
    const why = opts?.contextRisk?.reasons?.length
      ? ` (${opts.contextRisk.reasons.join(", ")})`
      : "";
    reason = `${ac.reversibility} throttled by live context-risk (ceiling L${contextCeiling} < L${threshold})${why} — gated`;
  } else if (!owned) {
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
  const forbidRules = parseForbidRules(worker.forbids).rules;
  for (const toolName of universe) {
    // The agent step itself is always allowed (reasoning, not a durable side-
    // effect — decideWorkerAction special-cases it); never self-block.
    if (toolName === "agent") continue;
    // Recipe-DSL ids (`github.create_issue`, `file.write`) are internal to the
    // recipe runner — the Claude subprocess never calls them by that name, so
    // they would be dead weight in `--disallowed-tools`. The camelCase MCP twin
    // (githubCreateIssue) is enumerated separately and IS emitted below.
    if (toolName.includes(".")) continue;
    // Rules are derived from the worker HERE rather than threaded in by the
    // caller. Every `decideWorkerAction` consumer that relies on a caller to
    // pass `forbidRules` is one forgetful call site away from a silent
    // fail-open — which is exactly how the enforcement path shipped wrong.
    // Deriving at the point of use removes that failure mode.
    const { action } = decideWorkerAction(
      worker,
      toolName,
      undefined,
      store,
      forbidRules.length > 0 ? { forbidRules } : undefined,
    );
    // `forbid` must block as hard as `gate` does. Testing only for "gate" let a
    // forbidden tool fall through this `continue` and stay OUT of the deny
    // list — leaving the agent step able to call the one thing no approval
    // unlocks, while the boundary screen said "not permitted".
    if (action !== "gate" && action !== "forbid") continue;
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
