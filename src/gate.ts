/**
 * The autonomy gate's public surface, for a consumer outside this package.
 *
 * ## Why this file exists at all
 *
 * `previewActions` already exists so that a screen showing "may do now / needs
 * approval / not permitted" is computed by the SAME code that enforces it.
 * Its own header states the reason: a preview holding policy of its own drifts,
 * and the drift is silent and permissive — a screen reading "not permitted"
 * where the gate would allow it tells an operator they are protected when they
 * are not. `ControlBoundary.tsx` is presentational for the same reason.
 *
 * That guarantee held only inside this repository. `package.json` exposes two
 * subpaths — `.` and `./plugin` — and `.` is `dist/index.js`, which is also the
 * `bin`: importing the package root RUNS THE CLI rather than yielding a module.
 * So an out-of-package consumer could not reach the gate at all, and its only
 * remaining option was to re-derive the three buckets from `boundary_receipts
 * .jsonl` and `worker_gate_decisions.jsonl` by hand — a second implementation
 * of the boundary, arrived at not by anyone deciding to have one but by the
 * export map being narrower than the guarantee.
 *
 * The compiled modules were already shipped (`files` carries `dist` wholesale),
 * so nothing new is published here. What changes is that the seam is now NAMED,
 * and a consumer gets the gate's answer instead of its ledger's residue.
 *
 * ## This is a re-export, and it must stay one
 *
 * Every binding below is the identity of the symbol it names. Nothing here
 * wraps, adapts, defaults or "simplifies" — a barrel that computed anything
 * would be the very second implementation the seam exists to prevent, sited
 * where it looks most like plumbing. `gateBarrelIsPassThrough.test.ts` asserts
 * reference identity against the source modules and fails if that changes.
 *
 * ## Scope: the decision, not the operation
 *
 * Exported: how an action is CLASSIFIED, what the gate DECIDES, and the types
 * to say either. Not exported: anything that writes a ledger, mutates a dial or
 * runs a recipe. A consumer of this surface asks questions; the runtime remains
 * the only thing that acts.
 */

// ── The decision ─────────────────────────────────────────────────────────────

export {
  type AutonomyDecisionOpts,
  decideWorkerAction,
  disallowedToolsForAgentStep,
  flowsUngated,
  GATE_POLICY_VERSION,
  type GateOutcome,
  gateOutcomeFor,
  mergeAgentDisallowedTools,
  type ResolvedGateOutcome,
  resolveGateOutcome,
  type StandingPermissionContext,
  type WorkerGateAction,
  type WorkerGateDecision,
} from "./workers/workerGate.js";

// ── The prospective view (the three columns) ─────────────────────────────────

export {
  type ActionBoundary,
  type CandidateAction,
  defaultCandidatesFor,
  type PreviewedAction,
  type PreviewOpts,
  previewActions,
} from "./workers/previewActions.js";

// ── What an action IS ────────────────────────────────────────────────────────

export {
  type ActionClass,
  AGENT_STEP_TOOL,
  classifyActionClass,
  knownActionDomains,
  knownActionTools,
  type MagnitudeBand,
  outcomeWeight,
  type Reversibility,
  reachableLevels,
} from "./workers/actionClass.js";

// ── Who the worker is, and what it owns ──────────────────────────────────────

export {
  ownsAction,
  ownsClassKey,
  parseWorker,
  priorFor,
  WORKER_ID_RE,
  type WorkerCompetence,
  type WorkerManifest,
  WorkerParseError,
} from "./workers/worker.js";

export { loadWorkersFromDir } from "./workers/workerLoader.js";

// ── The trust dial ───────────────────────────────────────────────────────────

export {
  DEFAULT_PRIOR,
  DEFAULT_THRESHOLDS,
  evidenceCount,
  type LevelOpts,
  type LevelResult,
  levelFromPosterior,
  lowerConfidenceBound,
  type Posterior,
  posteriorMean,
  posteriorStddev,
  type TrustLevel,
} from "./workers/trustLevel.js";
export {
  type AppliedOutcome,
  type BoardRow,
  WorkerLevelStore,
} from "./workers/workerLevelStore.js";

// ── The deny-list ────────────────────────────────────────────────────────────
//
// `parseForbidRules` REPORTS what it could not parse and drops it, which fails
// OPEN — correct at runtime, where a banned action degrading to merely gated is
// still recoverable because a human approves it. A consumer building a
// repository gate must invert that (see `workers authority-delta`): "I could
// not read your deny-list" may not resolve to "looks fine". The parser is
// exported with its report intact so that inversion stays possible.

export {
  describeForbidRules,
  type ForbidRule,
  type ForbidVerdict,
  isForbidden,
  type ParsedForbidRules,
  parseForbidRule,
  parseForbidRules,
} from "./workers/forbidPolicy.js";

// ── Descending-only situational risk ─────────────────────────────────────────

export {
  type ContextRisk,
  contextRiskCeiling,
} from "./workers/contextRisk.js";

// ── Standing permissions ─────────────────────────────────────────────────────
//
// A pre-recorded human approval, NOT earned trust, and deliberately not part of
// the `min()` in `decideWorkerAction`. Exported so a consumer can render why an
// action flowed without anyone being asked — never so it can grant one.

export {
  type CoverageOpts,
  coversAction,
  isActive,
  type PermissionCheck,
  type PermissionSubject,
  type StandingPermission,
} from "./butler/standingPermission.js";
