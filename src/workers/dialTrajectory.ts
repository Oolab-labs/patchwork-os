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
 * trajectory.
 *
 * ## Named `dialTrajectory`, not `shadowRun`
 *
 * It was `src/workers/shadowRun.ts`, which collided with the unrelated
 * `src/testing/shadowRun.ts` — a different harness, with its own reference
 * document (`documents/shadow-run-harness.md`) describing only that one.
 *
 * The collision had a cost. An audit looking for dead code found this file had
 * zero production importers and recommended deleting it. That reasoning was
 * wrong: this has tests, and `docs/design/worker-ramp-v0.md` lists it as a
 * deliberate Phase-1 artifact. It has no production caller because it is an
 * ANALYSIS HARNESS — you run it against recorded outcomes to answer "how many
 * observations does a worker need to climb each class, and how fast does one
 * catastrophic outcome demote it". A tool with no caller is not the same thing
 * as a tool with no purpose, and a name that suggests otherwise costs more
 * than a rename. This is the cheapest test of the evidence-latency risk: it shows,
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

export function dialTrajectory(
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
