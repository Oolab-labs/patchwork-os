import { categoriseHaltReason } from "../recipes/haltCategory.js";
import { classifyActionClass, type Reversibility } from "./actionClass.js";
import {
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
} from "./graduation.js";
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
    /** Persisted halt reason — used to tell a worker failure apart from a
     * human approval decision (the latter is not trust evidence; see L2). */
    haltReason?: string;
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

  constructor(
    workers: WorkerManifest[],
    opts: {
      store?: WorkerLevelStore;
      cfg?: GraduationConfig;
      now?: number;
      durabilityWindowMs?: number;
    } = {},
  ) {
    this.workers = workers;
    this.store = opts.store ?? new WorkerLevelStore();
    this.cfg = opts.cfg ?? DEFAULT_GRADUATION_CONFIG;
    this.now = opts.now;
    this.durabilityWindowMs =
      opts.durabilityWindowMs ?? DEFAULT_DURABILITY_WINDOW_MS;
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
      // Durable-outcome label: a recent SUCCESS on a non-reversible action is
      // provisional (a filed issue / pushed commit / merged PR can be reverted
      // or closed-as-junk minutes later), so it is NOT yet counted as evidence.
      // Only active when `now` was supplied by the I/O entry; otherwise the prior
      // status-only fold is used. Withholds evidence only → never widens.
      if (this.now !== undefined && step.status === "ok") {
        const ac = classifyActionClass(step.tool);
        if (
          !isDurableSuccess(
            ac.reversibility,
            run.at,
            this.now,
            this.durabilityWindowMs,
          )
        )
          continue; // pending — survives the window before it earns trust
      }
      this.store.apply(
        worker.id,
        { toolName: step.tool, good: step.status === "ok", at: run.at },
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
