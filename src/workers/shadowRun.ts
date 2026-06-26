import {
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
  type Outcome,
} from "./graduation.js";
import { priorFor, type WorkerManifest } from "./worker.js";
import {
  type AuditEvent,
  type BoardRow,
  WorkerLevelStore,
} from "./workerLevelStore.js";

/**
 * Replay an outcome sequence for a worker and capture the per-step dial
 * trajectory. This is the cheapest test of the evidence-latency risk: it shows,
 * deterministically, how many real observations (and how much wall-clock) a
 * worker needs to climb each class — and how one catastrophic outcome demotes
 * it in a single step. No model calls, no live gate — pure replay.
 */

export interface TrajectoryStep {
  index: number;
  at: number;
  toolName: string;
  good: boolean;
  classKey: string;
  level: number;
  changed: "promote" | "demote" | null;
}

export interface ShadowRunResult {
  workerId: string;
  trajectory: TrajectoryStep[];
  board: BoardRow[];
  events: AuditEvent[];
  store: WorkerLevelStore;
}

export function shadowRun(
  worker: WorkerManifest,
  outcomes: Outcome[],
  opts: { cfg?: GraduationConfig; store?: WorkerLevelStore } = {},
): ShadowRunResult {
  const store = opts.store ?? new WorkerLevelStore();
  const cfg = opts.cfg ?? DEFAULT_GRADUATION_CONFIG;
  const prior = priorFor(worker);
  const trajectory: TrajectoryStep[] = [];
  outcomes.forEach((o, index) => {
    const r = store.apply(worker.id, o, { prior, cfg });
    trajectory.push({
      index,
      at: o.at,
      toolName: o.toolName,
      good: o.good,
      classKey: r.classKey,
      level: r.state.level,
      changed: r.event?.type ?? null,
    });
  });
  return {
    workerId: worker.id,
    trajectory,
    board: store.board(worker.id),
    events: store.events(worker.id),
    store,
  };
}

/** First trajectory step where `classKey` reached at least `level`. */
export function firstReached(
  result: ShadowRunResult,
  classKey: string,
  level: number,
): TrajectoryStep | undefined {
  return result.trajectory.find(
    (s) => s.classKey === classKey && s.level >= level,
  );
}

/** Build a steady cadence of same-tool outcomes spaced `intervalMs` apart. */
export function cadence(
  toolName: string,
  count: number,
  opts: { startAt?: number; intervalMs?: number; good?: boolean } = {},
): Outcome[] {
  const start = opts.startAt ?? 0;
  const interval = opts.intervalMs ?? 6 * 60 * 60 * 1000; // 6h
  const good = opts.good ?? true;
  return Array.from({ length: count }, (_, i) => ({
    toolName,
    good,
    at: start + i * interval,
  }));
}
