/**
 * What-If Preview (P3) — cost projection from the P1 token corpus.
 *
 * Walks a recipe's agent steps and projects per-step token usage from the
 * persisted history (`RunStepResult.inputTokens/outputTokens/costUsd`, P1).
 * When a step has >= `threshold` historical samples the projection is the
 * MEDIAN of those runs ("history" basis); otherwise it falls back to the
 * coarse chars/4 prompt heuristic ("heuristic"); a recipe with no agent steps
 * is "unavailable".
 *
 * Honesty rules carried over from P1:
 *   - USD is projected ONLY from historical `costUsd` (present only for billable
 *     drivers + priced models). The default `claude-code`/subprocess driver has
 *     tokens but NO cost → we project TOKENS with a notional note and leave
 *     `usd` null. Never a $0 placeholder.
 *   - `confidence` is a first-class, loud field. `high` only when every agent
 *     step has enough samples; `low` when some are heuristic; `none` when there
 *     is nothing to go on.
 */

import type { RecipeDryRunPlan } from "../../commands/recipe.js";
import type { RecipeRunLog } from "../../runLog.js";
import type { SimulationCost } from "./types.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_RUNS = 50;
const DEFAULT_THRESHOLD = 5;

/** Median of a numeric array (average of the two middle values for even n). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

interface StepSamples {
  input: number[];
  output: number[];
  cost: number[];
}

/**
 * Project the cost of a recipe from its accrued run history. Pure except the
 * `runLog` read. Degrades to the P0 heuristic/unavailable shape when there is
 * no usable history, so callers can apply it unconditionally when a runLog is
 * available.
 */
export function projectCost(
  plan: RecipeDryRunPlan,
  runLog: RecipeRunLog,
  opts: { maxRuns?: number; threshold?: number } = {},
): SimulationCost {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const agentStepIds = plan.steps
    .filter((s) => s.type === "agent")
    .map((s) => s.id);
  const agentSteps = agentStepIds.length;

  // Prompt-heuristic fallback (chars/4) for steps lacking history. Only flat
  // agent steps carry `prompt` in the plan; chained ones don't.
  const promptTokensById = new Map<string, number>();
  for (const s of plan.steps) {
    if (s.type === "agent" && typeof s.prompt === "string" && s.prompt.length) {
      promptTokensById.set(s.id, Math.ceil(s.prompt.length / CHARS_PER_TOKEN));
    }
  }

  if (agentSteps === 0) {
    return {
      basis: "unavailable",
      confidence: "none",
      sampleRuns: 0,
      agentSteps: 0,
      estimatedAgentSteps: 0,
      estPromptTokens: null,
      estInputTokens: null,
      estOutputTokens: null,
      usd: null,
      minUsd: null,
      maxUsd: null,
      historyAgentSteps: 0,
      note: "No AI/agent steps — this recipe incurs no model cost.",
    };
  }

  const runs = runLog.query({
    recipe: plan.recipe,
    limit: opts.maxRuns ?? DEFAULT_MAX_RUNS,
  });

  // Collect per-step samples across history.
  const samples = new Map<string, StepSamples>();
  for (const id of agentStepIds) {
    samples.set(id, { input: [], output: [], cost: [] });
  }
  let sampleRuns = 0;
  for (const run of runs) {
    let contributed = false;
    for (const step of run.stepResults ?? []) {
      const bucket = samples.get(step.id);
      if (!bucket) continue;
      if (typeof step.inputTokens === "number") {
        bucket.input.push(step.inputTokens);
        contributed = true;
      }
      if (typeof step.outputTokens === "number") {
        bucket.output.push(step.outputTokens);
      }
      if (typeof step.costUsd === "number") {
        bucket.cost.push(step.costUsd);
      }
    }
    if (contributed) sampleRuns += 1;
  }

  let estInput = 0;
  let estOutput = 0;
  let expectedUsd = 0;
  let minUsd = 0;
  let maxUsd = 0;
  let anyTokenEstimate = false;
  let anyCost = false;
  let historyAgentSteps = 0;
  let estimatedAgentSteps = 0;
  let allStepsConfident = true;

  for (const id of agentStepIds) {
    const bucket = samples.get(id) as StepSamples;
    const hasHistory = bucket.input.length > 0;
    if (hasHistory) {
      historyAgentSteps += 1;
      estimatedAgentSteps += 1;
      anyTokenEstimate = true;
      estInput += median(bucket.input);
      estOutput += bucket.output.length > 0 ? median(bucket.output) : 0;
      if (bucket.input.length < threshold) allStepsConfident = false;
      if (bucket.cost.length > 0) {
        anyCost = true;
        expectedUsd += median(bucket.cost);
        minUsd += Math.min(...bucket.cost);
        maxUsd += Math.max(...bucket.cost);
      }
    } else {
      // No history — chars/4 prompt heuristic when available.
      const promptTokens = promptTokensById.get(id);
      allStepsConfident = false;
      if (promptTokens !== undefined) {
        estimatedAgentSteps += 1;
        anyTokenEstimate = true;
        estInput += promptTokens;
      }
    }
  }

  const basis: SimulationCost["basis"] =
    historyAgentSteps > 0
      ? "history"
      : estimatedAgentSteps > 0
        ? "heuristic"
        : "unavailable";
  const confidence: NonNullable<SimulationCost["confidence"]> =
    basis === "history"
      ? allStepsConfident && historyAgentSteps === agentSteps
        ? "high"
        : "low"
      : basis === "heuristic"
        ? "low"
        : "none";

  const note = buildNote({
    basis,
    confidence,
    sampleRuns,
    historyAgentSteps,
    agentSteps,
    anyCost,
    expectedUsd,
  });

  return {
    basis,
    confidence,
    sampleRuns,
    agentSteps,
    estimatedAgentSteps,
    // Back-compat: estPromptTokens kept as the chars/4 sum (input-only proxy).
    estPromptTokens: anyTokenEstimate ? estInput : null,
    estInputTokens: anyTokenEstimate ? estInput : null,
    estOutputTokens: anyTokenEstimate ? estOutput : null,
    usd: anyCost ? round4(expectedUsd) : null,
    minUsd: anyCost ? round4(minUsd) : null,
    maxUsd: anyCost ? round4(maxUsd) : null,
    historyAgentSteps,
    note,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function buildNote(p: {
  basis: SimulationCost["basis"];
  confidence: NonNullable<SimulationCost["confidence"]>;
  sampleRuns: number;
  historyAgentSteps: number;
  agentSteps: number;
  anyCost: boolean;
  expectedUsd: number;
}): string {
  if (p.basis === "unavailable") {
    return "No usable history or prompts — cost not estimable.";
  }
  if (p.basis === "heuristic") {
    return "Low-confidence chars/4 token estimate over agent prompts (no run history yet). USD not projected — accrue runs for a history-backed estimate.";
  }
  // history
  const cov = `${p.historyAgentSteps}/${p.agentSteps} agent step(s) backed by ${p.sampleRuns} prior run(s) (median; ${p.confidence} confidence)`;
  if (p.anyCost) {
    return `Token + USD projection from history — ${cov}. USD covers billable-driver steps only.`;
  }
  return `Token projection from history — ${cov}. USD not projected: the served driver is a subscription/subprocess driver that is not billed (notional only).`;
}
