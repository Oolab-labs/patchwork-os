/**
 * The storage seam for run evidence — ADR-0022.
 *
 * WHY THIS EXISTS. `runs.jsonl` is the autonomy gate's trust evidence and also
 * an append-only text file with no integrity properties. It failed three ways
 * in eight weeks, each silently: #1324 (`seq` collides across instances — 142
 * of 145 in the live log), #1340 (in-flight steps never reached disk), #1341
 * (a concurrent reader made `completeRun` a no-op, recording a successful run
 * as `interrupted, steps: 0`). Each was fixed; the pattern was not.
 *
 * This interface is the line those fixes kept crossing. It names what a run
 * store must DO, so an implementation can be swapped without every caller
 * learning how the bytes are laid out. `RecipeRunLog` is the incumbent
 * implementation; a SQLite one follows, and dual-write compares them before
 * anything flips.
 *
 * ## What this interface deliberately does NOT do
 *
 * It does not redesign what a run means. Every method mirrors a `RecipeRunLog`
 * method with the same name and semantics, including ones that are arguably
 * wrong (see `getBySeq`). A storage migration that also changes the domain
 * model cannot be verified by comparing old against new, because there is no
 * longer a fixed thing to compare — and comparison against the incumbent is
 * the entire safety argument for the migration.
 *
 * Fixing those wrong-but-preserved parts happens AFTER the stores agree, not
 * during.
 */

import type {
  RecipeRun,
  RunQuery,
  RunStepResult,
  RunTrigger,
  TerminalRunStatus,
} from "../runLog.js";

/** Arguments to {@link RunRepository.startRun}. Mirrors `RecipeRunLog.startRun`. */
export interface StartRunInput {
  taskId: string;
  recipeName: string;
  trigger: RunTrigger;
  createdAt: number;
  startedAt?: number;
  model?: string;
  parentSeq?: number;
  manualRunId?: string;
  /** Test seam — defaults to this process. See `RecipeRun.ownerPid`. */
  ownerPid?: number;
  /**
   * Adopt this `seq` instead of minting one. MIRRORING ONLY.
   *
   * Exists because dual-write is otherwise unusable: both stores mint their
   * own per-instance counter, so a mirrored run would carry a different `seq`
   * in each store, on every row. Comparison would then report a difference
   * every single time — and a divergence signal that always fires is
   * indistinguishable from one that never does. The noise would hide exactly
   * the real disagreement the comparison exists to catch.
   *
   * Ordinary callers must not pass this. It is not a way to choose an id: the
   * value is meaningless outside the process that minted it (#1324), which is
   * precisely why `task_id` is the real identity.
   */
  seq?: number;
}

/** Arguments to {@link RunRepository.completeRun}. Mirrors `RecipeRunLog.completeRun`. */
export interface CompleteRunInput {
  status: TerminalRunStatus;
  doneAt: number;
  durationMs: number;
  stepResults: RunStepResult[];
  outputTail?: string;
  errorMessage?: string;
  assertionFailures?: RecipeRun["assertionFailures"];
  inboxOutputs?: RecipeRun["inboxOutputs"];
  budgetWarnings?: RecipeRun["budgetWarnings"];
  tokenTotals?: RecipeRun["tokenTotals"];
  budgetTotals?: RecipeRun["budgetTotals"];
}

/**
 * A store of recipe runs and their steps.
 *
 * Implementations must be safe against a SECOND PROCESS writing the same
 * store concurrently. That is not a theoretical requirement: `runs.jsonl` has
 * eight construction sites, several of which write, and every one of the three
 * bugs above involved two writers or a writer and a reader disagreeing.
 */
export interface RunRepository {
  /**
   * Begin a run and return its `seq`.
   *
   * NOTE the returned `seq` is per-instance and therefore NOT unique across
   * processes (#1324). It is preserved because callers pass it back to
   * `updateRunSteps` / `completeRun` within one process, where it is
   * well-defined. Cross-process identity is `taskId`.
   */
  startRun(input: StartRunInput): number;

  /** Replace the step list of an in-flight run, persisting evidence as it arrives (#1340). */
  updateRunSteps(seq: number, stepResults: RunStepResult[]): void;

  /** Finish a run. Must be durable before returning. */
  completeRun(seq: number, input: CompleteRunInput): void;

  /**
   * Record an ALREADY-FINISHED run in one shot, allocating its `seq`.
   *
   * This is not a convenience wrapper around start+complete — it is the
   * dominant production write path, used by the flat and chained runners and
   * the CLI (5 call sites, versus 2 for `startRun`). Omitting it was a real
   * design error in the first cut of this interface: dual-write would have
   * silently missed every run written this way, and then reported divergence
   * on all of them.
   *
   * Implementations must derive `hadStepErrors` from `stepResults` exactly as
   * `completeRun` does, so a run recorded through this path is
   * indistinguishable from one recorded through the lifecycle path.
   */
  appendDirect(run: Omit<RecipeRun, "seq">): void;

  /** Query runs, newest first. */
  query(q?: RunQuery): RecipeRun[];

  /**
   * Look up one run by `seq`.
   *
   * PRESERVED AS-IS AND KNOWN TO BE WRONG (#1360): `seq` is not unique across
   * processes, so this can resolve to an arbitrary colliding run. It backs the
   * `/runs/[seq]` URL contract, so correcting it is a separate, visible change
   * — not something to slip in behind a storage swap.
   */
  getBySeq(seq: number): RecipeRun | null;

  /** `seq`s of runs whose `parentSeq` is the given run. */
  getChildSeqs(parentSeq: number): number[];

  /** Number of runs currently retained and readable. */
  size(): number;
}
