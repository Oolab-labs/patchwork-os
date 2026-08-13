/**
 * The incumbent JSONL store, behind the ADR-0022 repository seam.
 *
 * This adapter holds NO logic of its own — every method forwards to
 * `RecipeRunLog`. That is the point. It exists so the interface can be
 * introduced with provably zero behaviour change, which is what makes the
 * conformance suite meaningful: the suite is first pinned against the store
 * we already trust, and only then pointed at a new one.
 *
 * If this file ever grows a behavioural decision, the comparison it enables
 * stops being a comparison.
 */

import type { RecipeRun, RunQuery, RunStepResult } from "../runLog.js";
import { RecipeRunLog, type RunLogOptions } from "../runLog.js";
import type {
  CompleteRunInput,
  RunRepository,
  StartRunInput,
} from "./runRepository.js";

export class JsonlRunRepository implements RunRepository {
  constructor(private readonly log: RecipeRunLog) {}

  /** Convenience: build the adapter and the underlying log together. */
  static open(opts: RunLogOptions): JsonlRunRepository {
    return new JsonlRunRepository(new RecipeRunLog(opts));
  }

  /**
   * Escape hatch for callers still reaching for `RecipeRunLog`-only methods
   * (`record`, `appendDirect`, `readArchive`). Those are deliberately absent
   * from `RunRepository` — `readArchive` in particular is a JSONL rotation
   * detail with no meaning in a store that does not rotate by bytes.
   *
   * Every use of this is a migration debt marker, not an approved pattern.
   */
  get underlying(): RecipeRunLog {
    return this.log;
  }

  startRun(input: StartRunInput): number {
    return this.log.startRun(input);
  }

  updateRunSteps(seq: number, stepResults: RunStepResult[]): void {
    this.log.updateRunSteps(seq, stepResults);
  }

  completeRun(seq: number, input: CompleteRunInput): void {
    this.log.completeRun(seq, input);
  }

  query(q: RunQuery = {}): RecipeRun[] {
    return this.log.query(q);
  }

  getBySeq(seq: number): RecipeRun | null {
    return this.log.getBySeq(seq);
  }

  getChildSeqs(parentSeq: number): number[] {
    return this.log.getChildSeqs(parentSeq);
  }

  size(): number {
    return this.log.size();
  }
}
