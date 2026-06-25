/**
 * "Enable self-correction" recipe transform (#moat / strategic-D).
 *
 * Patchwork's judge→refine + escalate[] loop is the one feature no competing
 * agent runtime has — but today it's reachable only by hand-authoring
 * `kind: judge`, `reviews:`, `max_revisions:`, and `escalate:` YAML. This
 * pure transform powers a one-click "Enable self-correction" affordance in the
 * recipe editor: pick an agent step and it injects a sensible judge→refine
 * loop with a more-capable escalation ladder.
 *
 * It operates on the RAW YAML (parse → mutate → stringify), NOT the structured
 * form — the form is a lossy subset view (it doesn't model model/kind/escalate)
 * and round-tripping complex recipes through it drops fields (the documented
 * "complex YAML → raw editor" rule). Keeping the transform on the YAML text is
 * the only lossless path.
 *
 * Schema contract (src/recipes/schemaGenerator.ts):
 *   - the reviewed agent step gets `escalate: [{model}...]` (ordered
 *     more-capable fallbacks; the Nth request_changes revision re-runs it with
 *     escalate[N-1]).
 *   - a `kind: judge` step is inserted after it with `reviews: <into>`,
 *     `max_revisions`, `on_exhausted`.
 */

import { parse, stringify } from "yaml";

/**
 * Default escalation ladder. MODEL-ONLY (no `driver` override) so it stays
 * valid for every driver — API key OR subscription (`claude-code`) OR a local
 * base model keep their driver and only the model gets stronger. The user can
 * edit the rungs (e.g. prepend a local→cloud `driver` switch) afterwards.
 */
export const DEFAULT_ESCALATE_LADDER: ReadonlyArray<{ model: string }> = [
  { model: "claude-sonnet-4-6" },
  { model: "claude-opus-4-8" },
];

export const DEFAULT_MAX_REVISIONS = 2;

export interface SelfCorrectionResult {
  /** Transformed YAML — identical to the input when `changed` is false. */
  yaml: string;
  changed: boolean;
  /** Human-facing note: what happened, or why nothing did. */
  message: string;
}

interface LooseStep {
  id?: string;
  into?: string;
  tool?: unknown;
  tools?: unknown;
  agent?: unknown;
  kind?: string;
  reviews?: string;
  escalate?: unknown;
  [k: string]: unknown;
}

/** An agent step is one with an `agent` block that is NOT already a judge. */
function isAgentStep(s: LooseStep | null | undefined): boolean {
  return !!s && typeof s === "object" && !!s.agent && s.kind !== "judge";
}

function stepKey(s: LooseStep, index: number): string {
  return s.id ?? s.into ?? `step_${index + 1}`;
}

/**
 * Inject a judge→refine self-correction loop around one agent step.
 *
 * @param yamlText  the recipe YAML
 * @param targetStepId  id/into of the agent step to wrap; when omitted, the
 *   LAST agent step is used (the typical "judge the final output" case).
 */
export function enableSelfCorrection(
  yamlText: string,
  targetStepId?: string,
): SelfCorrectionResult {
  const noChange = (message: string): SelfCorrectionResult => ({
    yaml: yamlText,
    changed: false,
    message,
  });

  let doc: { steps?: LooseStep[] } | null;
  try {
    doc = parse(yamlText) as { steps?: LooseStep[] } | null;
  } catch {
    return noChange("Could not parse the recipe YAML — fix syntax first.");
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.steps)) {
    return noChange("Recipe has no steps to add self-correction to.");
  }
  const steps = doc.steps;

  let idx = -1;
  if (targetStepId) {
    idx = steps.findIndex(
      (s, i) => isAgentStep(s) && stepKey(s, i) === targetStepId,
    );
    if (idx === -1) {
      return noChange(`No agent step "${targetStepId}" found.`);
    }
  } else {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (isAgentStep(steps[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return noChange("No agent step found to add self-correction to.");
    }
  }

  const step = steps[idx]!;
  const into = step.into ?? stepKey(step, idx);

  // Idempotent: don't add a second judge for a step that already has one.
  if (steps.some((s) => s.kind === "judge" && s.reviews === into)) {
    return noChange(`"${into}" already has a self-correction judge.`);
  }

  // 1. The judge needs a stable output key to review.
  if (!step.into) step.into = into;

  // 2. Escalation ladder on the reviewed step — don't clobber an existing one.
  let addedLadder = false;
  if (!Array.isArray(step.escalate) || step.escalate.length === 0) {
    step.escalate = DEFAULT_ESCALATE_LADDER.map((r) => ({ ...r }));
    addedLadder = true;
  }

  // 3. Insert the judge step immediately after the reviewed step.
  const judge: LooseStep = {
    id: `${into}_review`,
    agent: {
      prompt:
        "Review the previous step's output for correctness, completeness, and " +
        "adherence to the task. Reply 'approve' if it is good, or " +
        "'request_changes' with a brief, specific reason.",
    },
    kind: "judge",
    reviews: into,
    max_revisions: DEFAULT_MAX_REVISIONS,
    on_exhausted: "proceed",
  };
  steps.splice(idx + 1, 0, judge);

  const ladderNote = addedLadder
    ? ` with a ${DEFAULT_ESCALATE_LADDER.length}-rung model-escalation ladder`
    : " (kept the step's existing escalation ladder)";
  return {
    yaml: stringify(doc),
    changed: true,
    message: `Added a self-correction judge for "${into}"${ladderNote}, up to ${DEFAULT_MAX_REVISIONS} revisions. Review the generated steps and tune the models/criteria before saving.`,
  };
}
