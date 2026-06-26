import { classifyActionClass } from "./actionClass.js";
import {
  type ClassTrustState,
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
  type GraduationEvent,
  graduate,
  initialState,
  type Outcome,
} from "./graduation.js";
import { DEFAULT_PRIOR, type Posterior, posteriorMean } from "./trustLevel.js";

/**
 * Holds the per-(worker × action-class) trust state and the promotion/demotion
 * event log. The state map is the dial; the event log is the compliance/audit
 * artifact ("prove this worker never acted beyond its authority"). In-memory
 * with a JSONL round-trip; wiring it to a live append-only JSONL file with the
 * tail-on-read concurrency pattern (ADR-0007, as the existing trace stores do)
 * is the productionization step — kept out of v0 to stay pure + testable.
 */

function compositeKey(workerId: string, classKey: string): string {
  return `${workerId}::${classKey}`;
}

export type AuditEvent = GraduationEvent & { workerId: string };

export interface AppliedOutcome {
  classKey: string;
  state: ClassTrustState;
  event?: AuditEvent;
}

export interface BoardRow {
  classKey: string;
  level: number;
  observations: number;
  mean: number;
}

export class WorkerLevelStore {
  private states = new Map<string, ClassTrustState>();
  private log: AuditEvent[] = [];

  /** Fold one outcome for a worker; derives the action-class from the tool. */
  apply(
    workerId: string,
    outcome: Outcome,
    opts: { prior?: Posterior; cfg?: GraduationConfig } = {},
  ): AppliedOutcome {
    const ac = classifyActionClass(outcome.toolName, outcome.params);
    const k = compositeKey(workerId, ac.key);
    const prior = opts.prior ?? DEFAULT_PRIOR;
    const current =
      this.states.get(k) ?? initialState(ac.key, prior, outcome.at);
    const { state, event } = graduate(
      current,
      outcome,
      opts.cfg ?? DEFAULT_GRADUATION_CONFIG,
    );
    this.states.set(k, state);
    const audit = event ? { ...event, workerId } : undefined;
    if (audit) this.log.push(audit);
    return { classKey: ac.key, state, event: audit };
  }

  getState(workerId: string, classKey: string): ClassTrustState | undefined {
    return this.states.get(compositeKey(workerId, classKey));
  }

  /** Dial snapshot for one worker: every action-class it has touched, sorted. */
  board(workerId: string): BoardRow[] {
    const prefix = `${workerId}::`;
    const rows: BoardRow[] = [];
    for (const [k, s] of this.states) {
      if (!k.startsWith(prefix)) continue;
      rows.push({
        classKey: s.classKey,
        level: s.level,
        observations: s.observations,
        mean: posteriorMean(s.posterior),
      });
    }
    return rows.sort((a, b) => a.classKey.localeCompare(b.classKey));
  }

  /** The audit log (optionally filtered to one worker). */
  events(workerId?: string): AuditEvent[] {
    return workerId
      ? this.log.filter((e) => e.workerId === workerId)
      : this.log;
  }

  /** Serialize states + events to JSONL (one record per line). */
  toJSONL(): string {
    const lines: string[] = [];
    for (const [k, s] of this.states) {
      const workerId = k.slice(0, k.indexOf("::"));
      lines.push(JSON.stringify({ rec: "state", workerId, state: s }));
    }
    for (const e of this.log)
      lines.push(JSON.stringify({ rec: "event", ...e }));
    return lines.join("\n");
  }

  static fromJSONL(text: string): WorkerLevelStore {
    const store = new WorkerLevelStore();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.rec === "state") {
        const workerId = obj.workerId as string;
        const state = obj.state as ClassTrustState;
        store.states.set(compositeKey(workerId, state.classKey), state);
      } else if (obj.rec === "event") {
        const { rec: _rec, ...event } = obj;
        store.log.push(event as unknown as AuditEvent);
      }
    }
    return store;
  }
}
