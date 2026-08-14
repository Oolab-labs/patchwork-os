/**
 * Dual-write with shadow reads — ADR-0022 step 1 of the migration.
 *
 * The primary (JSONL) stays the source of truth and answers every read. The
 * mirror (SQLite) receives every write and is read only to be COMPARED. When
 * the two disagree, that is reported; it never changes the answer.
 *
 * ## Why not just cut over
 *
 * The migration's safety argument is "the new store behaves like the one we
 * already trust". A test suite can only check that against cases someone
 * thought to write. This checks it against YOUR ACTUAL TRAFFIC, in production,
 * while the store being replaced is still authoritative — including through
 * the first rotation, which on this installation has never once executed
 * (`runs.jsonl.1` has never been written) and is the moment the old store is
 * most likely to lose something.
 *
 * ## Two rules that make this safe
 *
 * 1. **The mirror can never break the primary.** Every mirror call is wrapped;
 *    a failure is reported and swallowed. A migration aid that can take down
 *    the system it is de-risking is worse than no migration aid.
 *
 * 2. **The mirror can never change an answer.** Reads return the primary's
 *    result, always, even when the mirror looks more correct. The moment
 *    divergence could alter behaviour, this stops being an observation and
 *    becomes an untested cutover.
 *
 * The point at which those rules relax is the flip, and the flip has an
 * explicit gate: #1324, #1340 and rotation loss replayed against both stores,
 * with JSONL visibly LOSING all three (ADR-0022 §4).
 */

import type { RecipeRun, RunQuery, RunStepResult } from "../runLog.js";
import type {
  CompleteRunInput,
  RunRepository,
  StartRunInput,
} from "./runRepository.js";

/** One observed disagreement between the two stores. */
export interface Divergence {
  /** Which read surfaced it. */
  operation: "query" | "getBySeq" | "getChildSeqs" | "size";
  /** Machine-usable summary — what differed, in one short phrase. */
  detail: string;
  /** The run the disagreement concerns, when it concerns one. */
  taskId?: string;
}

/** One mirror-side failure. Reported, never thrown. */
export interface MirrorFailure {
  operation: string;
  message: string;
}

export interface DualWriteOptions {
  /** Called for every observed disagreement. Must not throw. */
  onDivergence?: (d: Divergence) => void;
  /** Called when a mirror operation fails. Must not throw. */
  onMirrorFailure?: (f: MirrorFailure) => void;
  /**
   * Compare reads. Default true. Turning it off keeps the mirror populated
   * without paying the comparison cost — useful once agreement is
   * established and you only want the data present for the flip.
   */
  compareReads?: boolean;
}

/**
 * Fields compared between stores.
 *
 * Deliberately explicit rather than a deep-equal over the whole record. A
 * blanket comparison would flag differences that carry no meaning — key order,
 * an absent optional versus an explicit `undefined` — and a report full of
 * those is one nobody reads. Every field here is one whose disagreement would
 * mean the stores genuinely remember different things.
 */
const COMPARED = [
  "taskId",
  "seq",
  "recipeName",
  "trigger",
  "status",
  "createdAt",
  "doneAt",
  "durationMs",
  "errorMessage",
  "parentSeq",
  "manualRunId",
  "hadStepErrors",
] as const;

function stepIds(steps: RunStepResult[] | undefined): string {
  return (steps ?? [])
    .map((s) => s?.id)
    .filter(Boolean)
    .join(",");
}

/** Differences between one run as each store remembers it. Empty ⇒ agreement. */
export function diffRun(primary: RecipeRun, mirror: RecipeRun): string[] {
  const out: string[] = [];
  for (const k of COMPARED) {
    const a = primary[k as keyof RecipeRun];
    const b = mirror[k as keyof RecipeRun];
    // `undefined` and absent mean the same thing to every reader of this data,
    // so treat them as equal rather than manufacturing a difference.
    if ((a ?? undefined) !== (b ?? undefined)) {
      out.push(`${k}: primary=${String(a)} mirror=${String(b)}`);
    }
  }
  const pa = stepIds(primary.stepResults);
  const pb = stepIds(mirror.stepResults);
  if (pa !== pb) out.push(`stepResults: primary=[${pa}] mirror=[${pb}]`);
  return out;
}

export class DualWriteRunRepository implements RunRepository {
  constructor(
    private readonly primary: RunRepository,
    private readonly mirror: RunRepository,
    private readonly opts: DualWriteOptions = {},
  ) {}

  /** Run a mirror operation. Never throws; a failure is reported and dropped. */
  private safely<T>(operation: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      try {
        this.opts.onMirrorFailure?.({
          operation,
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // A reporting callback that throws must not become the outage the
        // mirror was forbidden from causing.
      }
      return undefined;
    }
  }

  private report(d: Divergence): void {
    try {
      this.opts.onDivergence?.(d);
    } catch {
      // Same reasoning as above.
    }
  }

  private get comparing(): boolean {
    return this.opts.compareReads !== false;
  }

  startRun(input: StartRunInput): number {
    const seq = this.primary.startRun(input);
    // Mirror adopts the primary's seq — see StartRunInput.seq. Without this
    // every mirrored row differs on `seq` and the comparison is all noise.
    this.safely("startRun", () => this.mirror.startRun({ ...input, seq }));
    return seq;
  }

  updateRunSteps(seq: number, stepResults: RunStepResult[]): void {
    this.primary.updateRunSteps(seq, stepResults);
    this.safely("updateRunSteps", () =>
      this.mirror.updateRunSteps(seq, stepResults),
    );
  }

  completeRun(seq: number, input: CompleteRunInput): void {
    this.primary.completeRun(seq, input);
    this.safely("completeRun", () => this.mirror.completeRun(seq, input));
  }

  query(q: RunQuery = {}): RecipeRun[] {
    const primary = this.primary.query(q);
    if (!this.comparing) return primary;

    const mirror = this.safely("query", () => this.mirror.query(q));
    if (mirror === undefined) return primary;

    if (primary.length !== mirror.length) {
      this.report({
        operation: "query",
        detail: `row count: primary=${primary.length} mirror=${mirror.length}`,
      });
      return primary;
    }
    // Compare by taskId rather than by position: a pure ORDER difference is
    // worth knowing about, but it must not masquerade as every row differing.
    const byId = new Map(mirror.map((r) => [r.taskId, r]));
    for (const p of primary) {
      const m = byId.get(p.taskId);
      if (!m) {
        this.report({
          operation: "query",
          taskId: p.taskId,
          detail: "present in primary, absent from mirror",
        });
        continue;
      }
      for (const d of diffRun(p, m)) {
        this.report({ operation: "query", taskId: p.taskId, detail: d });
      }
    }
    const orderPrimary = primary.map((r) => r.taskId).join(",");
    const orderMirror = mirror.map((r) => r.taskId).join(",");
    if (orderPrimary !== orderMirror) {
      this.report({
        operation: "query",
        detail: "same rows, different order",
      });
    }
    return primary;
  }

  getBySeq(seq: number): RecipeRun | null {
    const primary = this.primary.getBySeq(seq);
    if (!this.comparing) return primary;

    const mirror = this.safely("getBySeq", () => this.mirror.getBySeq(seq));
    if (mirror === undefined) return primary;

    if (primary && mirror) {
      for (const d of diffRun(primary, mirror)) {
        this.report({
          operation: "getBySeq",
          taskId: primary.taskId,
          detail: d,
        });
      }
    } else if (primary !== mirror) {
      this.report({
        operation: "getBySeq",
        detail: `presence: primary=${primary ? "found" : "null"} mirror=${mirror ? "found" : "null"}`,
      });
    }
    return primary;
  }

  getChildSeqs(parentSeq: number): number[] {
    const primary = this.primary.getChildSeqs(parentSeq);
    if (!this.comparing) return primary;

    const mirror = this.safely("getChildSeqs", () =>
      this.mirror.getChildSeqs(parentSeq),
    );
    if (mirror === undefined) return primary;

    const a = [...primary].sort((x, y) => x - y).join(",");
    const b = [...mirror].sort((x, y) => x - y).join(",");
    if (a !== b) {
      this.report({
        operation: "getChildSeqs",
        detail: `children of ${parentSeq}: primary=[${a}] mirror=[${b}]`,
      });
    }
    return primary;
  }

  size(): number {
    const primary = this.primary.size();
    if (!this.comparing) return primary;

    const mirror = this.safely("size", () => this.mirror.size());
    if (mirror !== undefined && mirror !== primary) {
      this.report({
        operation: "size",
        detail: `primary=${primary} mirror=${mirror}`,
      });
    }
    return primary;
  }
}
