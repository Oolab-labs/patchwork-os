/**
 * What-If Preview — effective-policy projection.
 *
 * Answers "would the runtime hold this step for a human?" for every step of a
 * simulated recipe, by running the SAME calculation the runners consult per
 * step: `explainRecipePolicy` (the body of `patchwork policy explain`) builds
 * each step's `EffectivePolicyInput` and calls `computeEffectivePolicy`. This
 * module only maps those verdicts onto the dry-run plan's step ids — it holds
 * no rule of its own, because a preview with its own rule drifts from
 * enforcement and the drift is silent.
 */

import type { RecipeDryRunPlan } from "../../commands/recipe.js";
import type {
  EffectivePolicy,
  PolicyStage,
} from "../../governance/effectivePolicy.js";
import type { loadConfig } from "../../patchworkConfig.js";
import type { SimulationPolicy } from "./types.js";

export interface ProjectPolicyOptions {
  /** Config to evaluate under; defaults to the loaded `config.json`. */
  config?: ReturnType<typeof loadConfig>;
  workersDir?: string;
  patchworkDir?: string;
  /**
   * Raw `steps:` index of the selected step when the plan was narrowed to one
   * step (`--step`). Flat plans are matched to explained steps by position.
   */
  selectedIndex?: number;
}

/** The stage that decided the final verdict, for a one-line reason. */
function decidingReason(result: EffectivePolicy): string {
  const find = (pred: (s: PolicyStage) => boolean) =>
    result.stages.find(pred)?.reason;
  if (result.final === "REFUSED") {
    return find((s) => s.verdict === "REFUSE") ?? "refused";
  }
  if (!result.consultsApproval) {
    return find((s) => s.stage === "trigger") ?? "approval gate not consulted";
  }
  if (result.final === "HUMAN_APPROVAL_REQUIRED") {
    return (
      find(
        (s) =>
          (s.stage === "worker_authority" || s.stage === "tool_tier") &&
          s.verdict === "APPROVAL",
      ) ?? "approval required"
    );
  }
  return find((s) => s.stage === "tool_tier") ?? "allowed";
}

export async function projectRecipePolicy(
  recipeFile: string,
  plan: RecipeDryRunPlan,
  opts: ProjectPolicyOptions = {},
): Promise<SimulationPolicy> {
  const { explainRecipePolicy } = await import(
    "../../commands/policyExplain.js"
  );
  const explained = await explainRecipePolicy(recipeFile, {
    ...(opts.config && { config: opts.config }),
    ...(opts.workersDir && { workersDir: opts.workersDir }),
    ...(opts.patchworkDir && { patchworkDir: opts.patchworkDir }),
  });

  const steps: SimulationPolicy["steps"] = new Map();
  const chained = plan.triggerType === "chained";
  for (const [i, planStep] of plan.steps.entries()) {
    // Chained steps carry a required `id`, which is also explain's step id.
    // Flat plan ids fall back differently (tool id vs `step_N`), so flat
    // steps are matched by their position in `steps:` instead.
    const rawIndex = opts.selectedIndex ?? i;
    const match = chained
      ? explained.steps.find((e) => e.stepId === planStep.id)
      : explained.steps.find((e) => e.index === rawIndex);
    if (!match) continue;
    steps.set(planStep.id, {
      final: match.result.final,
      consultsApproval: match.result.consultsApproval,
      reason: decidingReason(match.result),
    });
  }

  // The trigger the verdicts were computed for (explain evaluates a top-level
  // chained run as "manual", as the chained runner does).
  const evaluated = explained.steps[0]?.input.trigger;
  return {
    profile: explained.profileMode === "governed" ? "governed" : "compat",
    trigger: String(
      evaluated ??
        (explained.trigger === "chained" ? "manual" : explained.trigger),
    ),
    steps,
  };
}
