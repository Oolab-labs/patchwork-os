import { categoriseHaltReason } from "../recipes/haltCategory.js";
import {
  AGENT_STEP_TOOL,
  classifyActionClass,
  type Reversibility,
} from "./actionClass.js";
import { deriveActionKey } from "./actionRef.js";
import {
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
} from "./graduation.js";
import type { OutcomeStore } from "./outcomeStore.js";
import { recommend } from "./shadowGate.js";
import {
  ownsAction,
  ownsClassKey,
  priorFor,
  type WorkerManifest,
} from "./worker.js";
import {
  type AuditEvent,
  type BoardRow,
  WorkerLevelStore,
} from "./workerLevelStore.js";

/**
 * Read-only shadow logger. Consumes signals the bridge ALREADY persists —
 * RecipeRunLog outcomes (the dial's evidence) and ActivityLog approval
 * decisions (the live gate's actual calls) — and maintains the trust dial +
 * a "what the ramp WOULD have decided vs what the gate DID" comparison. It
 * never touches the live gate: the gate's own decision log IS the input, so
 * this observes the live path with zero hot-path risk. (worker-ramp-v0, shadow)
 */

/** A recipe run, reduced to what the dial needs (maps from RecipeRun). */
export interface RunRecord {
  recipeName: string;
  /** epoch ms */
  at: number;
  steps: Array<{
    tool?: string;
    status: "ok" | "skipped" | "error";
    /**
     * Step inputs after template substitution. Load-bearing for TRUST, not
     * just for display: the action-class key carries a magnitude band for
     * value-bearing domains, so evidence recorded without params classifies to
     * the WIDEST band. That does not merely disable the protection, it inverts
     * it — cheap successes would credit the expensive cell and make the large
     * action more likely to auto-allow the more small ones succeeded.
     */
    resolvedParams?: Record<string, unknown>;
    /** Persisted halt reason — used to tell a worker failure apart from a
     * human approval decision (the latter is not trust evidence; see L2). */
    haltReason?: string;
    /**
     * Captured tool output for outcome attribution. Only populated for
     * github.create_issue steps (contains `{url, issueNumber}`). Used by
     * ingestRun to look up the issue's eventual disposition in the outcome
     * store so junk filings flip to good:false rather than counting as earned
     * trust. See outcomeStore.ts.
     */
    output?: Record<string, unknown>;
  }>;
}

/** A live gate decision (maps from an ActivityLog approval_decision row). */
export interface DecisionRecord {
  toolName: string;
  /** the gate's actual verdict */
  decision: "allow" | "deny";
  at: number;
  params?: Record<string, unknown>;
  /** Present only on worker-gate decisions (recipe runner path). Absent on
   * Claude-session MCP tool approvals — the shadow only counts worker-gate
   * decisions so mixing in session approvals won't inflate divergences. */
  recipeName?: string;
}

export interface Divergence {
  classKey: string;
  toolName: string;
  ramp: "queue" | "bypass";
  gate: "allow" | "deny";
  at: number;
  note: string;
}

export interface WorkerShadowReport {
  workerId: string;
  name: string;
  autonomyCeiling: number;
  /** Dial rows. `owned: false` = the worker performed this class but does not
   * own it, so the live gate floors it to L0 regardless of accrued evidence. */
  board: Array<BoardRow & { owned: boolean }>;
  events: AuditEvent[];
  /** ramp-vs-gate comparison over attributable decisions */
  compared: number;
  agreed: number;
  divergences: Divergence[];
}

interface CompareSlot {
  compared: number;
  agreed: number;
  divergences: Divergence[];
}

/** Default durability window — a non-reversible success must survive this long
 *  before it counts as earned trust. 24h is long enough to catch a revert /
 *  close-as-junk / rollback, short enough that a genuinely-good action graduates
 *  within a day. */
export const DEFAULT_DURABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Durable-outcome label. `good = step.status:ok` is an OPTIMISTIC proxy: a PR
 * that merged, an issue that filed — but a junk issue closed seconds later, or a
 * commit reverted within the hour, "succeeded" at the moment yet is not earned
 * trust. So a SUCCESS on a non-reversible (compensable/irreversible) action is
 * "durable" — i.e. counts as evidence — only once it has survived the durability
 * window. Reversible successes (undoable / re-runnable: reads, ledgered writes,
 * local commits, CI) are always durable. Failures are unaffected (a failure is
 * durable evidence of failure regardless of age).
 *
 * This only ever WITHHOLDS recent risky successes (reduces evidence → lower
 * trust → more gating), so it never widens autonomy. See
 * docs/worker-autonomy-policy-gate.md §3d.
 */
export function isDurableSuccess(
  reversibility: Reversibility,
  runAt: number,
  now: number,
  windowMs: number,
): boolean {
  if (reversibility === "reversible") return true;
  return runAt <= now - windowMs;
}

/** A single step reduced to what the outcome fold needs. */
type FoldStep = Pick<RunRecord["steps"][number], "tool" | "status" | "output">;

/**
 * The durable-outcome fold decision for one step — the SINGLE source of truth
 * shared by the live/shadow dial (`WorkerShadowObserver.ingestRun`) and the
 * cold-start backtest (`backtestWorker`), so the two can never drift on how an
 * outcome is labelled. Returns either "withhold" (not evidence — a pending or
 * unknown-disposition risky success) or "count as good/bad".
 *
 * Assumes the caller has already skipped no-tool / skipped / approval-rejected
 * steps (those are non-evidence for reasons the caller owns). Semantics (the
 * junk check runs BEFORE the durability window — a human rejection is durable
 * evidence of failure the moment it lands, so it demotes instantly, like any
 * outright failure; only confirmed/unknown successes wait out the window):
 *   - agent (reasoning) step, ANY status       → WITHHOLD (not a durable action; see below)
 *   - failure (status ≠ ok)                    → count, good:false (durable evidence of failure)
 *   - success, no `now`                        → count, good:true (back-compat status-only)
 *   - success, non-reversible, junk (any age)  → count, good:false (human-rejected → demotes now)
 *   - success, non-reversible, pre-window      → WITHHOLD (provisional; not yet durable)
 *   - success, non-reversible, unknown/null    → WITHHOLD (unactioned ≠ correct; trust-by-neglect fix)
 *   - success, non-reversible, UNKEYABLE + store → WITHHOLD (unidentifiable ≠ approved)
 *   - success, otherwise (reversible / confirmed / no store) → count, good:true
 */
export type FoldDecision = { fold: false } | { fold: true; good: boolean };

export function foldOutcome(
  step: FoldStep,
  runAt: number,
  opts: {
    now?: number;
    windowMs: number;
    outcomeStore?: OutcomeStore;
    /**
     * Key the outcome join on tool-name + external id rather than on
     * `output.url` alone. Defaults to TRUE (#1319).
     *
     * Retained as an explicit opt-OUT rather than deleted: it is the only way
     * to reproduce the historical labelling when replaying an old run log, and
     * `foldJoinDelta` needs both sides to report a divergence at all. Passing
     * `false` restores the pre-#1319 behaviour, in which a non-reversible
     * success carrying no URL earned full trust with no confirmation.
     */
    strictOutcomeJoin?: boolean;
  },
): FoldDecision {
  if (!step.tool) return { fold: false };
  // An agent (reasoning) step is NOT evidence, in either direction.
  //
  // The gate already decided this: `decideWorkerAction` carves `agent` out
  // explicitly as "not a gated action-class", because the subprocess only
  // produces an output variable and any tools it calls gate on their OWN
  // class. The fold did not mirror that, so the two components disagreed
  // about what an agent step IS — the gate said "not a durable action", the
  // fold said "an irreversible action that succeeded, credit it". That is
  // drift, not design, and it ran one way: 50 agent successes in the real run
  // log folded as good:true, unconfirmed positives that no human ever saw.
  //
  // Currently latent rather than exploitable — `agent` classifies as
  // `other:irreversible:medium` and no worker manifest owns the `other`
  // domain, so the gate floors that class to L0 regardless of accrued
  // evidence (verified across the shipped templates AND the live workers
  // dir). But it is ARMED: adding `other` to any worker's `owns` would
  // instantly convert those unconfirmed credits into real trust, which is
  // not something anyone editing an `owns` list would expect. See the
  // companion guard test.
  //
  // Withheld in BOTH directions on purpose. Counting a failed agent step as
  // evidence of worker unreliability is equally wrong: the step failing says
  // something about a model call, not about whether this worker can be
  // trusted with a side effect. Neither credit nor penalty.
  if (step.tool === AGENT_STEP_TOOL) return { fold: false };
  if (step.status !== "ok") return { fold: true, good: false };
  // Success. Without a wall-clock, keep the prior status-only fold (back-compat).
  if (opts.now === undefined) return { fold: true, good: true };
  const ac = classifyActionClass(step.tool);
  // For a non-reversible filing, read the operator disposition up front (issue /
  // PR URL). Reversible successes never consult the store — they are always durable.
  const outcomeStore =
    ac.reversibility !== "reversible" ? opts.outcomeStore : undefined;
  // The join key for this action. The historical rule keyed on `output.url`
  // alone, so any write tool returning no URL skipped the human-confirmation
  // check entirely and fell through to good:true below — full earned trust for
  // work nobody ever looked at. `deriveActionKey` keys on tool-name + external
  // id instead (see actionRef.ts), which every write tool already has.
  //
  // Now ON by default (#1319). The blast radius was measured over the real run
  // log before flipping — ONE step changed label (a butler-errand
  // `todoist.create_task`, good -> withheld). It is small for a reason worth
  // knowing: of 63 non-reversible successes, 50 are `agent` steps that capture
  // no output at all and 12 are `http.post` whose id sits inside a JSON string
  // body, so only 1 is keyable today. Fixing the key made the mechanism
  // correct; it did not make it REACH much. Widening that coverage is a
  // separate piece of work (step-output capture), deliberately not smuggled in
  // here.
  const key =
    (opts.strictOutcomeJoin ?? true)
      ? outcomeStore
        ? deriveActionKey(step.tool, step.output)
        : null
      : outcomeStore && step.output && typeof step.output.url === "string"
        ? step.output.url
        : null;
  const disposition = key ? (outcomeStore?.getDisposition(key) ?? null) : null;
  // A human REJECTION demotes IMMEDIATELY. Junk is durable evidence of failure
  // the moment it lands, so — like any outright failure (status ≠ ok above) — it
  // must NOT sit withheld for the durability window ("demotion is instant", see
  // trustLevel.ts). Checked BEFORE the window. Confirmed/unknown must NOT
  // short-circuit the window: folding a still-provisional success early would
  // WIDEN evidence, so this is junk-early only.
  if (disposition === "junk") return { fold: true, good: false };
  if (!isDurableSuccess(ac.reversibility, runAt, opts.now, opts.windowMs))
    return { fold: false }; // pending — survives the window before it earns trust
  // Past the window: an unactioned filing (unknown / no record) is WITHHELD —
  // unactioned ≠ correct (trust-by-neglect fix). Confirmed → good:true.
  if (key && (disposition === "unknown" || disposition === null))
    return { fold: false }; // withheld — not evidence
  // UNKEYABLE, and non-reversible, with a store configured. The action cannot
  // be referred to at all, so no human could ever have ruled on it — and the
  // withhold branch above, which is guarded on `key`, does not fire. Without
  // this the step falls through to good:true: "we cannot identify this action"
  // silently becomes "a human approved it". That is the same fallthrough
  // #1318/#1319 closed twice already, in its last remaining form, and it lands
  // on the riskiest actions rather than the safest — `http.post` classifies
  // `http:irreversible:medium` and brand-exposed.
  //
  // Scoped to "a store is configured" on purpose. When no OutcomeStore is
  // wired at all, nothing can ever be confirmed, so withholding here would
  // silently zero every non-reversible action for callers that never opted
  // into outcome tracking (the pure-fold tests, and any backtest run without
  // a store). That is a deployment state, not a property of the action, and
  // conflating the two would be a much larger behaviour change smuggled in
  // under a narrower one.
  //
  // Scoped to the strict join as well: the opt-out path exists ONLY to
  // reproduce the historical labelling byte-for-byte when replaying an old run
  // log, and a withhold it never had would defeat that.
  if (!key && outcomeStore && (opts.strictOutcomeJoin ?? true))
    return { fold: false }; // withheld — unidentifiable
  return { fold: true, good: true };
}

/**
 * How `foldOutcome` would label this step under BOTH join rules — the measured
 * blast radius of turning `strictOutcomeJoin` on, without turning it on.
 *
 * Returns null when the two agree (the overwhelmingly common case, and the
 * only case an operator does not need to see).
 */
export function foldJoinDelta(
  step: FoldStep,
  runAt: number,
  opts: { now?: number; windowMs: number; outcomeStore?: OutcomeStore },
): { tool: string; lenient: FoldDecision; strict: FoldDecision } | null {
  const lenient = foldOutcome(step, runAt, {
    ...opts,
    strictOutcomeJoin: false,
  });
  const strict = foldOutcome(step, runAt, { ...opts, strictOutcomeJoin: true });
  const same =
    lenient.fold === strict.fold &&
    (!lenient.fold || !strict.fold || lenient.good === strict.good);
  if (same) return null;
  return { tool: step.tool ?? "(none)", lenient, strict };
}

export class WorkerShadowObserver {
  private readonly store: WorkerLevelStore;
  private readonly cfg: GraduationConfig;
  private readonly workers: WorkerManifest[];
  private readonly compare = new Map<string, CompareSlot>();
  /** Wall-clock supplied by the I/O entry (the observer stays pure — no
   *  Date.now). When set, durable-outcome labelling is active; when undefined,
   *  the prior status-only behaviour is preserved (back-compat for pure tests). */
  private readonly now?: number;
  private readonly durabilityWindowMs: number;
  /** Optional outcome store — when present, junk issues flip good:false past
   *  the durability window instead of counting as earned trust. */
  private readonly outcomeStore?: OutcomeStore;

  constructor(
    workers: WorkerManifest[],
    opts: {
      store?: WorkerLevelStore;
      cfg?: GraduationConfig;
      now?: number;
      durabilityWindowMs?: number;
      outcomeStore?: OutcomeStore;
    } = {},
  ) {
    this.workers = workers;
    this.store = opts.store ?? new WorkerLevelStore();
    this.cfg = opts.cfg ?? DEFAULT_GRADUATION_CONFIG;
    this.now = opts.now;
    this.durabilityWindowMs =
      opts.durabilityWindowMs ?? DEFAULT_DURABILITY_WINDOW_MS;
    this.outcomeStore = opts.outcomeStore;
  }

  /**
   * The populated level store. Exposed so the LIVE worker-autonomy gate
   * (`workerGate.decideWorkerAction`) can read the same earned levels this
   * observer derives from the run log — one source of truth for the dial and
   * the gate. Read-only intent; callers must not mutate.
   */
  get levelStore(): WorkerLevelStore {
    return this.store;
  }

  /** The worker whose recipe body is `recipeName`, if any. */
  workerForRecipe(recipeName: string): WorkerManifest | undefined {
    return this.workers.find((w) => w.recipe === recipeName);
  }

  /** Attribute a tool call to its SOLE owning worker (ambiguous → skip). */
  private workerForAction(
    toolName: string,
    params?: Record<string, unknown>,
  ): WorkerManifest | undefined {
    const ac = classifyActionClass(toolName, params);
    const owners = this.workers.filter((w) => ownsAction(w, ac));
    return owners.length === 1 ? owners[0] : undefined;
  }

  /** Feed a recipe run's step outcomes into the owning worker's dial. */
  ingestRun(run: RunRecord): void {
    const worker = this.workerForRecipe(run.recipeName);
    if (!worker) return;
    const prior = priorFor(worker);
    for (const step of run.steps) {
      if (!step.tool || step.status === "skipped") continue; // skipped ≠ evidence
      // L2: a step halted because a HUMAN rejected / let expire / cancelled the
      // approval is a control decision, not a worker failure — counting it as
      // `good: false` would demote the worker for every correct "not yet", so
      // the gate could never self-clear. Skip it (non-evidence). Genuine tool
      // errors still count.
      if (
        step.status === "error" &&
        categoriseHaltReason(step.haltReason) === "approval_rejected"
      )
        continue;
      // Durable-outcome fold (shared with the backtest via foldOutcome): a recent
      // SUCCESS on a non-reversible action is provisional, and past the window a
      // junk filing flips good:false while an unknown/unactioned one is WITHHELD
      // (trust-by-neglect fix). Only active when `now` was supplied; otherwise the
      // prior status-only fold is used. Withholds evidence only → never widens.
      const decision = foldOutcome(step, run.at, {
        now: this.now,
        windowMs: this.durabilityWindowMs,
        outcomeStore: this.outcomeStore,
      });
      if (!decision.fold) continue;
      this.store.apply(
        worker.id,
        {
          toolName: step.tool,
          ...(step.resolvedParams && { params: step.resolvedParams }),
          good: decision.good,
          at: run.at,
        },
        { prior, cfg: this.cfg },
      );
    }
  }

  /** Compare what the ramp WOULD recommend (given the dial as of now) against
   * the gate's actual decision. Read-only — records agreement + divergences.
   *
   * Only worker-gate decisions (those with a recipeName) are counted. Plain
   * Claude-session MCP tool approvals share the same ActivityLog event type
   * but have no recipeName — including them would inflate divergences with
   * calls the worker gate never saw. */
  ingestDecision(d: DecisionRecord): void {
    if (!d.recipeName) return;
    const worker = this.workerForAction(d.toolName, d.params);
    if (!worker) return;
    const rec = recommend(worker, d.toolName, d.params, this.store);
    const rampBypass = rec.decision === "bypass";
    const gateAllowed = d.decision === "allow";
    // ramp "bypass" ↔ gate would not need to gate; ramp "queue" ↔ gate gates.
    const agree = rampBypass === gateAllowed;
    const slot = this.compare.get(worker.id) ?? {
      compared: 0,
      agreed: 0,
      divergences: [],
    };
    slot.compared++;
    if (agree) {
      slot.agreed++;
    } else {
      slot.divergences.push({
        classKey: rec.classKey,
        toolName: d.toolName,
        ramp: rec.decision,
        gate: d.decision,
        at: d.at,
        note: rampBypass
          ? `ramp would auto-run (${rec.reason}); gate still gated`
          : "ramp would gate; gate allowed",
      });
    }
    this.compare.set(worker.id, slot);
  }

  report(): WorkerShadowReport[] {
    return this.workers.map((w) => {
      const c = this.compare.get(w.id) ?? {
        compared: 0,
        agreed: 0,
        divergences: [],
      };
      return {
        workerId: w.id,
        name: w.name,
        autonomyCeiling: w.autonomyCeiling,
        // L3: flag rows for classes the worker performs but does NOT own — the
        // dial shows accrued evidence there, but the live gate floors them to 0
        // (a worker has no standing trust outside its `owns`). Without the flag
        // the dial looks like earned autonomy that the gate silently ignores.
        board: this.store
          .board(w.id)
          .map((r) => ({ ...r, owned: ownsClassKey(w, r.classKey) })),
        events: this.store.events(w.id),
        compared: c.compared,
        agreed: c.agreed,
        divergences: c.divergences,
      };
    });
  }
}
