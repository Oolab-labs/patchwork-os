import { classifyActionClass } from "./actionClass.js";
import {
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
} from "./graduation.js";
import { recommend } from "./shadowGate.js";
import { ownsAction, priorFor, type WorkerManifest } from "./worker.js";
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
  steps: Array<{ tool?: string; status: "ok" | "skipped" | "error" }>;
}

/** A live gate decision (maps from an ActivityLog approval_decision row). */
export interface DecisionRecord {
  toolName: string;
  /** the gate's actual verdict */
  decision: "allow" | "deny";
  at: number;
  params?: Record<string, unknown>;
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
  board: BoardRow[];
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

export class WorkerShadowObserver {
  private readonly store: WorkerLevelStore;
  private readonly cfg: GraduationConfig;
  private readonly workers: WorkerManifest[];
  private readonly compare = new Map<string, CompareSlot>();

  constructor(
    workers: WorkerManifest[],
    opts: { store?: WorkerLevelStore; cfg?: GraduationConfig } = {},
  ) {
    this.workers = workers;
    this.store = opts.store ?? new WorkerLevelStore();
    this.cfg = opts.cfg ?? DEFAULT_GRADUATION_CONFIG;
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
      this.store.apply(
        worker.id,
        { toolName: step.tool, good: step.status === "ok", at: run.at },
        { prior, cfg: this.cfg },
      );
    }
  }

  /** Compare what the ramp WOULD recommend (given the dial as of now) against
   * the gate's actual decision. Read-only — records agreement + divergences. */
  ingestDecision(d: DecisionRecord): void {
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
          ? "ramp would auto-run (earned L4); gate still gated"
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
        board: this.store.board(w.id),
        events: this.store.events(w.id),
        compared: c.compared,
        agreed: c.agreed,
        divergences: c.divergences,
      };
    });
  }
}
