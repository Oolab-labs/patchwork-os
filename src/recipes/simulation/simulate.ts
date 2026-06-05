/**
 * What-If Preview — static simulation core.
 *
 * `simulateFromPlan` is a PURE transform: dry-run plan → simulation report.
 * It performs no I/O and has no clock dependency (it reuses the plan's
 * `generatedAt`), so it is fully deterministic and unit-testable. The
 * I/O-bearing entrypoint (`runRecipeSimulate`, which produces the plan first)
 * lives in `src/commands/recipe.ts`.
 */

import type {
  RecipeDryRunPlan,
  RecipeDryRunPlanStep,
} from "../../commands/recipe.js";
import { computeEffectiveRisks, summarizeRunRisk } from "./aggregateRunRisk.js";
import {
  classifyStepSideEffect,
  emptySideEffectCounts,
} from "./sideEffects.js";
import {
  type ApprovalProjection,
  type BranchProjection,
  type RecipeSimulationReport,
  type RiskTier,
  SIMULATION_SCHEMA_VERSION,
  type SimulationCost,
  type SimulationStep,
} from "./types.js";

/** Chars-per-token heuristic, matching the codebase's deliberately-rough estimate. */
const CHARS_PER_TOKEN = 4;

const isTier = (v: unknown): v is RiskTier =>
  v === "low" || v === "medium" || v === "high";

/** A step is "resolved" unless it is a tool whose id was not in the registry. */
function stepResolved(step: RecipeDryRunPlanStep): boolean {
  if (step.type !== "tool") return true;
  return step.resolved === true;
}

function buildSteps(
  plan: RecipeDryRunPlan,
  topology: "chained" | "flat",
): SimulationStep[] {
  const baseRisks = plan.steps.map(
    (s): { id: string; baseRisk: RiskTier; dependencies?: string[] } => ({
      id: s.id,
      baseRisk: isTier(s.risk) ? s.risk : "low",
      ...(s.dependencies ? { dependencies: s.dependencies } : {}),
    }),
  );
  const effective = computeEffectiveRisks(baseRisks, topology);

  return plan.steps.map((s): SimulationStep => {
    const resolved = stepResolved(s);
    const isWrite = s.isWrite === true;
    const isConnector = s.isConnector === true;
    const baseRisk = isTier(s.risk) ? s.risk : "low";
    const sideEffect = classifyStepSideEffect({
      type: s.type,
      ...(s.tool !== undefined ? { tool: s.tool } : {}),
      ...(s.namespace !== undefined ? { namespace: s.namespace } : {}),
      resolved,
      isWrite,
      isConnector,
    });
    return {
      id: s.id,
      type: s.type,
      ...(s.tool !== undefined ? { tool: s.tool } : {}),
      ...(s.namespace !== undefined ? { namespace: s.namespace } : {}),
      resolved,
      ...(s.optional !== undefined ? { optional: s.optional } : {}),
      ...(s.dependencies ? { dependencies: s.dependencies } : {}),
      ...(s.condition !== undefined ? { condition: s.condition } : {}),
      baseRisk,
      effectiveRisk: effective.get(s.id) ?? baseRisk,
      sideEffect,
      isWrite,
      isConnector,
    };
  });
}

function buildCost(plan: RecipeDryRunPlan): SimulationCost {
  const agentPlanSteps = plan.steps.filter((s) => s.type === "agent");
  const agentSteps = agentPlanSteps.length;
  const withPrompt = agentPlanSteps.filter(
    (s) => typeof s.prompt === "string" && s.prompt.length > 0,
  );
  const estimatedAgentSteps = withPrompt.length;

  if (agentSteps === 0) {
    return {
      basis: "unavailable",
      agentSteps: 0,
      estimatedAgentSteps: 0,
      estPromptTokens: null,
      usd: null,
      note: "No AI/agent steps — this recipe incurs no model cost.",
    };
  }

  if (estimatedAgentSteps === 0) {
    return {
      basis: "unavailable",
      agentSteps,
      estimatedAgentSteps: 0,
      estPromptTokens: null,
      usd: null,
      note: "Agent prompts are not present in the static plan for this recipe topology — cost not estimable until a mocked/sandbox run (later phase).",
    };
  }

  const estPromptTokens = withPrompt.reduce(
    (sum, s) => sum + Math.ceil((s.prompt as string).length / CHARS_PER_TOKEN),
    0,
  );
  return {
    basis: "heuristic",
    agentSteps,
    estimatedAgentSteps,
    estPromptTokens,
    usd: null,
    note: "Low-confidence chars/4 token estimate over agent prompts (input only). USD is not projected at static fidelity — the default driver is a subscription/subprocess driver that is not billed; set an API driver + budget for a cost number.",
  };
}

/** Pure transform: a dry-run plan → a What-If Preview simulation report. */
export function simulateFromPlan(
  plan: RecipeDryRunPlan,
): RecipeSimulationReport {
  const topology: "chained" | "flat" =
    plan.triggerType === "chained" ? "chained" : "flat";
  const gatedOnRecipeSteps = false; // P0/P4 truth: recipe steps are not gated today.

  const steps = buildSteps(plan, topology);

  const sideEffectCounts = emptySideEffectCounts();
  for (const s of steps) sideEffectCounts[s.sideEffect] += 1;

  const summary = {
    totalSteps: steps.length,
    writeSteps: steps.filter((s) => s.isWrite).length,
    connectorSteps: steps.filter((s) => s.isConnector).length,
    agentSteps: steps.filter((s) => s.type === "agent").length,
    unresolvedSteps: steps.filter((s) => !s.resolved).length,
    sideEffectCounts,
    connectorNamespaces: plan.connectorNamespaces ?? [],
  };

  const risk = summarizeRunRisk(
    steps.map((s) => ({
      effectiveRisk: s.effectiveRisk,
      sideEffect: s.sideEffect,
      resolved: s.resolved,
    })),
  );

  const projected: ApprovalProjection[] = steps
    .filter((s) => s.baseRisk !== "low" || s.isWrite)
    .map((s) => ({
      stepId: s.id,
      ...(s.tool !== undefined ? { tool: s.tool } : {}),
      tier: s.baseRisk,
      wouldRequireApproval: s.baseRisk !== "low",
      reason:
        s.baseRisk !== "low"
          ? `${s.baseRisk}-risk ${s.sideEffect}`
          : `write step (${s.sideEffect}), low tier`,
    }));

  const branches: BranchProjection[] = steps
    .filter((s) => typeof s.condition === "string" && s.condition.length > 0)
    .map((s) => ({
      stepId: s.id,
      condition: s.condition as string,
      outcome: "undetermined" as const,
      reason:
        "Condition is evaluated at runtime against prior step output, which is not available in a static simulation.",
    }));

  const cost = buildCost(plan);

  const notes: string[] = [
    "Static fidelity: no step is executed. Agent/LLM outputs and data-dependent branches are not resolved.",
    "Approval projection shows the tier that WOULD apply if recipe steps were gated — they are NOT gated on the execution path today (gatedOnRecipeSteps=false).",
    "Cost is a low-confidence estimate; USD is not projected at this phase.",
  ];
  if (topology === "flat") {
    notes.push(
      "Flat recipe: risk propagates linearly (step N inherits prior steps' risk); there is no dependency DAG.",
    );
  }
  if (summary.unresolvedSteps > 0) {
    notes.push(
      `${summary.unresolvedSteps} step(s) reference tools unknown to the registry — their side effects could not be classified.`,
    );
  }
  if (branches.length > 0) {
    notes.push(
      `${branches.length} conditional branch(es) left undetermined — re-run after a mocked/sandbox phase to resolve them.`,
    );
  }

  return {
    schemaVersion: SIMULATION_SCHEMA_VERSION,
    kind: "what-if-preview",
    recipe: plan.recipe,
    triggerType: plan.triggerType,
    generatedAt: plan.generatedAt,
    fidelity: "static",
    topology,
    gatedOnRecipeSteps,
    steps,
    summary,
    risk,
    approvals: {
      gatedOnRecipeSteps,
      projected,
      note: "Recipe-runner steps are NOT gated by the approval queue today; this column is the tier that would apply if they were.",
    },
    cost,
    branches,
    lint: plan.lint,
    notes,
  };
}
