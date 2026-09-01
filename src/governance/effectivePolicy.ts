/**
 * Effective policy — one deterministic calculation answering
 * "what can this recipe / worker / tool actually do right now?"
 *
 * It COMPOSES the existing pure decision functions; it replaces none of them:
 *
 *   kill switch   → readKillSwitch                       (killSwitchPolicy.ts)
 *   worker        → decideWorkerAction + resolveGateOutcome (workers/workerGate.ts)
 *   privacy       → decideBoundary                       (privacy/dataPolicy.ts)
 *   tool tier     → classifyTool                         (riskTier.ts)
 *   profile       → resolveProfile                       (profile.ts)
 *
 * The runtime and `patchwork policy explain` call the SAME functions in this
 * file (`shouldConsultApproval`, `tierVerdict`, `computeEffectivePolicy`), so
 * the explanation cannot drift from enforcement. `effectivePolicy.test.ts`
 * asserts preview == enforcement over a matrix of inputs.
 *
 * Stage order is the runtime order (see ARCHITECTURE note in the Phase 0
 * report): kill switch → authority (worker, tool tier, trigger) → privacy →
 * approval → dispatch. A REFUSE at any stage is final; an APPROVAL at any
 * stage is final unless a later stage refuses.
 */

import type { RiskTier } from "../riskTier.js";
import type { BoundaryDecision } from "../privacy/dataPolicy.js";
import type { WorkerGateAction } from "../workers/workerGate.js";
import type { GovernanceProfile } from "./profile.js";

export type TriggerKind =
  | "manual"
  | "cron"
  | "webhook"
  | "file_watch"
  | "git_hook"
  | "on_file_save"
  | "on_test_run"
  | "chained"
  | "nested"
  | "replay"
  | "local"
  | (string & {});

export interface ToolFacts {
  id: string;
  /** From `classifyTool(id)`. */
  tier: RiskTier;
  /** From the recipe tool registry; `undefined` when the id is not registered. */
  isWrite?: boolean;
  /** True when the registry (or an explicit map) supplied the tier; false when inferred from the name. */
  tierDeclared: boolean;
  /** False when nothing is registered under this id. */
  registered: boolean;
  /** True for `agent:` steps (tool id "agent"). */
  isAgentStep?: boolean;
  /** For agent steps: whether containment is enforced for this step. */
  agentContained?: boolean;
  /** For agent steps: widenings the step requested. */
  agentWidenings?: string[];
}

export interface WorkerFacts {
  id: string;
  action: WorkerGateAction;
  /** Rule id from the decision record, when known. */
  ruleId?: string;
  standingPermissionId?: string;
}

export interface PrivacyFacts {
  classification: string;
  destination: string;
  decision: BoundaryDecision;
  reason?: string;
}

export interface EffectivePolicyInput {
  profile: GovernanceProfile;
  recipe: { name: string; requireApproval?: boolean };
  trigger: TriggerKind;
  tool: ToolFacts;
  /** Present only when a worker owns the recipe and its gate is active. */
  worker?: WorkerFacts;
  /** Present only for agent steps with a registered destination. */
  privacy?: PrivacyFacts;
  killSwitch: { engaged: boolean; reason: string };
  /** Per-recipe tool allowlist, when declared (`tools:` on the recipe). */
  recipeToolAllowlist?: string[];
}

export type StageVerdict = "ALLOW" | "APPROVAL" | "REFUSE" | "SKIP" | "N/A";

export interface PolicyStage {
  stage:
    | "kill_switch"
    | "tool_registration"
    | "recipe_tool_allowlist"
    | "worker_authority"
    | "tool_tier"
    | "trigger"
    | "privacy"
    | "standing_permission";
  verdict: StageVerdict;
  reason: string;
}

export type FinalVerdict = "ALLOW" | "HUMAN_APPROVAL_REQUIRED" | "REFUSED";

export interface EffectivePolicy {
  final: FinalVerdict;
  stages: PolicyStage[];
  /** True when the runtime will call the approval fn for this step. */
  consultsApproval: boolean;
}

/**
 * Does the TRIGGER put this step in front of the approval fn at all?
 * This is the predicate the flat and chained runners evaluate. Kept as one
 * function so `policy explain` and the runner cannot disagree about it.
 */
export function shouldConsultApproval(args: {
  profile: GovernanceProfile;
  trigger: TriggerKind;
  recipeRequireApproval?: boolean;
  /** The worker gate is injected (compat: worker flag on + manifest). */
  workerGateInjected: boolean;
  /** An approval fn was injected at all (approvalGate != off, or worker). */
  approvalFnInjected: boolean;
}): { consult: boolean; reason: string } {
  const { profile, trigger, recipeRequireApproval, workerGateInjected, approvalFnInjected } =
    args;
  if (!approvalFnInjected) {
    return { consult: false, reason: "no approval gate configured (approvalGate: off)" };
  }
  const automated = trigger !== "manual";
  const gateAutomated = profile.gateAutomatedRuns || workerGateInjected;
  if (automated && !gateAutomated) {
    return {
      consult: false,
      reason: `trigger ${trigger} is not gated (compat profile: manual runs only)`,
    };
  }
  if (recipeRequireApproval === false) {
    if (workerGateInjected) {
      return { consult: true, reason: "recipe requireApproval:false cannot opt out of worker governance" };
    }
    if (!profile.recipeOptOutHonoured) {
      return { consult: true, reason: "recipe requireApproval:false ignored under governed profile" };
    }
    return { consult: false, reason: "recipe opted out (requireApproval: false)" };
  }
  return {
    consult: true,
    reason: automated ? `trigger ${trigger} gated like a manual run` : "manual run",
  };
}

/**
 * The TIER half: given the approval-gate level and what we know about the
 * tool, does the tier gate want a human? Mirrors `makeRecipeApprovalFn`'s
 * threshold plus the governed rules for unknown write tools and agent steps.
 */
export function tierVerdict(
  profile: GovernanceProfile,
  tool: ToolFacts,
): { verdict: "ALLOW" | "APPROVAL"; reason: string } {
  const gate = profile.approvalGate;
  if (gate === "off") return { verdict: "ALLOW", reason: "approval gate off" };
  if (tool.isAgentStep) {
    if (profile.agentContainment === "enforced") {
      return tool.agentContained
        ? {
            verdict: tool.agentWidenings?.length ? "APPROVAL" : "ALLOW",
            reason: tool.agentWidenings?.length
              ? `agent step widened containment (${tool.agentWidenings.join(", ")})`
              : "agent step contained (read-only tools, no network, no shell)",
          }
        : { verdict: "APPROVAL", reason: "agent step not contained" };
    }
    // compat: agent classified by name → medium → passes under "high"
    return gate === "all"
      ? { verdict: "APPROVAL", reason: "approval gate: all" }
      : { verdict: "ALLOW", reason: "agent step tier medium < high" };
  }
  if (gate === "all") return { verdict: "APPROVAL", reason: "approval gate: all" };
  if (tool.tier === "high") return { verdict: "APPROVAL", reason: "tool tier high" };
  if (
    profile.unknownWriteTools === "gate" &&
    tool.isWrite !== false &&
    (!tool.tierDeclared || tool.isWrite === undefined)
  ) {
    return {
      verdict: "APPROVAL",
      reason: tool.registered
        ? "write tool with inferred tier gated under governed profile"
        : "tool of unknown provenance gated under governed profile",
    };
  }
  return { verdict: "ALLOW", reason: `tool tier ${tool.tier} below threshold` };
}

export function computeEffectivePolicy(input: EffectivePolicyInput): EffectivePolicy {
  const { profile, tool } = input;
  const stages: PolicyStage[] = [];

  // 1. Kill switch — absolute.
  if (input.killSwitch.engaged) {
    stages.push({ stage: "kill_switch", verdict: "REFUSE", reason: input.killSwitch.reason });
    return { final: "REFUSED", stages, consultsApproval: false };
  }
  stages.push({ stage: "kill_switch", verdict: "ALLOW", reason: input.killSwitch.reason });

  // 2. Registration.
  if (!tool.registered && !tool.isAgentStep) {
    if (profile.unregisteredTools === "refuse") {
      stages.push({
        stage: "tool_registration",
        verdict: "REFUSE",
        reason: `tool ${tool.id} is not registered (governed profile refuses rather than skips)`,
      });
      return { final: "REFUSED", stages, consultsApproval: false };
    }
    stages.push({
      stage: "tool_registration",
      verdict: "SKIP",
      reason: `tool ${tool.id} is not registered — step skipped (compat forward-compat rule)`,
    });
    return { final: "ALLOW", stages, consultsApproval: false };
  }
  stages.push({ stage: "tool_registration", verdict: "ALLOW", reason: "tool registered" });

  // 3. Recipe tool allowlist.
  if (input.recipeToolAllowlist && !tool.isAgentStep) {
    if (!input.recipeToolAllowlist.includes(tool.id)) {
      stages.push({
        stage: "recipe_tool_allowlist",
        verdict: "REFUSE",
        reason: `tool ${tool.id} not in recipe tools: allowlist`,
      });
      return { final: "REFUSED", stages, consultsApproval: false };
    }
    stages.push({ stage: "recipe_tool_allowlist", verdict: "ALLOW", reason: "tool declared" });
  } else {
    stages.push({ stage: "recipe_tool_allowlist", verdict: "N/A", reason: "no allowlist declared" });
  }

  // 4. Worker authority (forbid is final; gate → approval unless standing).
  let workerWantsApproval = false;
  if (input.worker) {
    const w = input.worker;
    if (w.action === "forbid") {
      stages.push({
        stage: "worker_authority",
        verdict: "REFUSE",
        reason: `worker ${w.id} forbids this action (${w.ruleId ?? "forbid rule"}) — no approval can unlock it`,
      });
      return { final: "REFUSED", stages, consultsApproval: false };
    }
    if (w.action === "gate") {
      if (w.standingPermissionId) {
        stages.push({
          stage: "worker_authority",
          verdict: "APPROVAL",
          reason: `worker ${w.id} has not earned this action`,
        });
        stages.push({
          stage: "standing_permission",
          verdict: "ALLOW",
          reason: `standing permission ${w.standingPermissionId} converts queue → flow`,
        });
      } else {
        workerWantsApproval = true;
        stages.push({
          stage: "worker_authority",
          verdict: "APPROVAL",
          reason: `worker ${w.id} has not earned this action (${w.ruleId ?? "trust below threshold"})`,
        });
        stages.push({ stage: "standing_permission", verdict: "N/A", reason: "none" });
      }
    } else {
      stages.push({
        stage: "worker_authority",
        verdict: "ALLOW",
        reason: `worker ${w.id} may act autonomously (${w.ruleId ?? "earned"})`,
      });
    }
  } else {
    stages.push({ stage: "worker_authority", verdict: "N/A", reason: "no worker owns this recipe" });
  }

  // 5. Tool tier.
  const tier = tierVerdict(profile, tool);
  stages.push({ stage: "tool_tier", verdict: tier.verdict, reason: tier.reason });

  // 6. Trigger — does the approval fn get consulted at all?
  const consult = shouldConsultApproval({
    profile,
    trigger: input.trigger,
    recipeRequireApproval: input.recipe.requireApproval,
    workerGateInjected: input.worker !== undefined,
    approvalFnInjected: profile.approvalGate !== "off" || input.worker !== undefined,
  });
  stages.push({
    stage: "trigger",
    verdict: consult.consult ? "ALLOW" : "SKIP",
    reason: consult.reason,
  });

  // 7. Privacy — refuses everything but ALLOW (executeAgent's rule).
  if (input.privacy) {
    const p = input.privacy;
    if (p.decision === "ALLOW") {
      stages.push({
        stage: "privacy",
        verdict: "ALLOW",
        reason: `${p.classification} → ${p.destination} allowed`,
      });
    } else {
      stages.push({
        stage: "privacy",
        verdict: "REFUSE",
        reason: `${p.classification} → ${p.destination}: ${p.decision}${p.reason ? ` (${p.reason})` : ""}`,
      });
      return { final: "REFUSED", stages, consultsApproval: false };
    }
  } else {
    stages.push({
      stage: "privacy",
      verdict: "N/A",
      reason: tool.isAgentStep ? "no destination registered" : "not a model dispatch",
    });
  }

  // Final composition.
  const wantsApproval = consult.consult && (tier.verdict === "APPROVAL" || workerWantsApproval);
  return {
    final: wantsApproval ? "HUMAN_APPROVAL_REQUIRED" : "ALLOW",
    stages,
    consultsApproval: consult.consult,
  };
}

/** Plain-text rendering for `patchwork policy explain`. */
export function formatEffectivePolicy(
  input: EffectivePolicyInput,
  result: EffectivePolicy,
): string {
  const lines: string[] = [];
  lines.push(`RECIPE: ${input.recipe.name}`);
  lines.push(`PROFILE: ${input.profile.mode.toUpperCase()}${input.profile.declared ? "" : " (defaulted — no profile: key)"}`);
  lines.push(`TRIGGER: ${String(input.trigger).toUpperCase()}`);
  lines.push(`TOOL: ${input.tool.id}${input.tool.isAgentStep ? " (agent step)" : ""}`);
  lines.push(`TOOL RISK: ${input.tool.tier.toUpperCase()}${input.tool.tierDeclared ? "" : " (inferred from name)"}${input.tool.isWrite ? " · WRITE" : ""}`);
  if (input.worker) lines.push(`WORKER: ${input.worker.id}`);
  lines.push("");
  for (const s of result.stages) {
    lines.push(`${s.stage.padEnd(22)} ${s.verdict.padEnd(9)} ${s.reason}`);
  }
  lines.push("");
  const label =
    result.final === "ALLOW"
      ? "ALLOWED"
      : result.final === "HUMAN_APPROVAL_REQUIRED"
        ? "HUMAN APPROVAL REQUIRED"
        : "REFUSED";
  lines.push(`FINAL RESULT: ${label}`);
  return lines.join("\n");
}
