import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./fileLockSync.js";
import type { Logger } from "./logger.js";
import {
  appendStepEvidence,
  isEvidenceBearing,
  loadStepEvidence,
} from "./runStepLedger.js";

/**
 * RecipeRunLog — persistent audit trail of every recipe execution.
 *
 * A "run" is any orchestrator task whose triggerSource identifies it as recipe-
 * derived (prefix `cron:`, `webhook:`, or `recipe:`). Runs are appended to a
 * JSONL file so overnight/background activity survives bridge restarts, and
 * mirrored into a bounded in-memory ring for quick dashboard reads.
 *
 * Schema is deliberately minimal + additive: extra fields go in without a
 * migration. Consumers must tolerate unknown keys.
 *
 * **Two consumers, not one.** `runs.jsonl` is read by (1) the dashboard/CLI
 * for run history + cost reporting, and (2) the worker-autonomy trust-replay
 * system (`src/workers/`), which treats this log as its de-facto outcome
 * corpus for computing per-worker × action-class trust levels. A schema
 * change or field drop here silently affects both — always check both call
 * sites before changing what gets persisted.
 *
 * Disk rotation (see `rotateDisk`) trims `runs.jsonl` at a 1 MB / 10k-line
 * threshold. Rotation and append both happen under the same advisory file
 * lock (`withFileLockSync`) so a concurrent bridge process can't append
 * between the rotation's temp-write and rename and have that row silently
 * dropped — see the `append()` implementation for the exact ordering.
 */

export type RunTrigger = "cron" | "webhook" | "recipe";
export type RunStatus =
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

/** Terminal statuses — `"running"` excluded. */
export type TerminalRunStatus = Exclude<RunStatus, "running">;

export interface RunStepResult {
  id: string;
  tool?: string;
  status: "ok" | "skipped" | "error";
  error?: string;
  /**
   * One-sentence human-actionable halt reason. Populated only for error
   * rows; present for runs produced by yamlRunner from this version
   * onward. Older runs.jsonl rows round-trip unchanged. See StepResult in
   * src/recipes/yamlRunner.ts for the construction sites.
   */
  haltReason?: string;
  /**
   * PR3a — judge-step verdict. Present only when the step was a
   * `kind: "judge"` agent step. Augment-only: `request_changes` does
   * NOT make `status: "error"`. Surfaced separately in dashboards.
   */
  judgeVerdict?: import("./recipes/judgeVerdict.js").JudgeVerdict;
  durationMs: number;
  // VD-2: per-step capture for diff hover + replay. All optional —
  // older `runs.jsonl` rows that pre-date VD-2 round-trip unchanged. Each
  // value passes through `captureForRunlog` (sensitive-key redaction +
  // 8 KB cap + truncation envelope).
  /** Step-input params after `{{template}}` substitution. */
  resolvedParams?: unknown;
  /** Step output value (`result.data` from the executor). */
  output?: unknown;
  /** Snapshot of `OutputRegistry` AFTER this step completed —
   *  `Map<stepId, StepOutput>`. Used by Phase-3 diff hover. */
  registrySnapshot?: Record<string, unknown>;
  /** Step start time (ms epoch) — useful for live-tail correlation. */
  startedAt?: number;
  /**
   * P1 cost/token corpus — agent token usage for this step, SUMMED across
   * every agent call the step made (a judge→refine step makes several).
   * Additive + optional: ABSENT for non-agent (tool) steps and for steps
   * served by drivers that report no usage (subscription Claude CLI, some
   * local stacks). Pre-P1 `runs.jsonl` rows round-trip unchanged (omitted).
   */
  inputTokens?: number;
  /** P1 — see `inputTokens`. Summed across all agent calls for this step. */
  outputTokens?: number;
  /**
   * P1 — measured USD cost for this step's token usage. Set ONLY when the
   * served model is actually priceable (billable driver + model present in
   * the price table). NEVER `0` as a placeholder — OMITTED when unpriceable
   * (subscription / unmeasured driver, or model absent from the price table).
   */
  costUsd?: number;
}

export interface RecipeRun {
  /** Monotonic sequence id within the process — stable for pagination. */
  seq: number;
  /** Orchestrator task id — useful for cross-referencing /tasks. */
  taskId: string;
  /** Recipe name extracted from triggerSource. */
  recipeName: string;
  /** Trigger kind: how the recipe fired. */
  trigger: RunTrigger;
  /** Terminal task status. */
  status: RunStatus;
  /** Task creation time (ms epoch). */
  createdAt: number;
  /** Task start time (ms epoch) — undefined if cancelled before spawn. */
  startedAt?: number;
  /** Task completion time (ms epoch). */
  doneAt: number;
  /** Model used, if known. */
  model?: string;
  /** Truncated output tail — first 2KB, enough for a "RECIPE DONE:" line. */
  outputTail?: string;
  /** Error message for failed runs. */
  errorMessage?: string;
  /** Duration ms = doneAt - (startedAt ?? createdAt). */
  durationMs: number;
  /** Per-step execution results — present when run via yamlRunner or chainedRunner. */
  stepResults?: RunStepResult[];
  /**
   * True when the run finished `done` but at least one step ended with
   * `status: "error"`. The runner continues past a non-fatal step
   * error, so such a run is legitimately `done` — but flat-green
   * "success" hides that a step failed. Consumers (the dashboard
   * Overview) use this to render an honest "completed with errors"
   * state. Absent / false = a clean run.
   */
  hadStepErrors?: boolean;
  /** seq of the parent run that triggered this one, if trigger === "recipe". */
  parentSeq?: number;
  /** Assertion failures from the recipe's expect block — present when assertions fail. */
  assertionFailures?: Array<{
    assertion: string;
    expected: unknown;
    actual: unknown;
    message: string;
  }>;
  /**
   * Stable id for one *logical* user-initiated execution attempt (PR5b
   * prereq). Distinct from `seq` (which is per *physical* run row): a
   * retry-after-failure of the same logical attempt re-uses the same
   * `manualRunId` so the disk-backed WriteEffectLedger can scope dedup
   * by `(recipeName, manualRunId)` and avoid replaying side effects.
   *
   * Optional — cron / webhook / nested-recipe trigger runs leave it
   * unset. Caller-supplied (the CLI / dashboard mints it); the run log
   * just round-trips the value.
   */
  manualRunId?: string;
  /**
   * PID of the process that started this run.
   *
   * Exists so the startup sweep can tell "the bridge died mid-run" from
   * "another process is running this right now". `runs.jsonl` is shared by
   * eight construction sites, and the sweep marked every `"running"` row
   * `interrupted` in the constructor — so any short-lived reader (a CLI verb,
   * the dashboard, a second bridge) declared a live sibling's runs dead. That
   * terminal row then beat the live one in `syncFromDisk`, and `completeRun`
   * no-ops on a non-running row, so a run that SUCCEEDED recorded
   * `interrupted` with zero steps.
   *
   * Optional: rows written before this field existed carry no stamp, and are
   * swept exactly as before — an unknown owner is not evidence of a live one.
   */
  ownerPid?: number;
  /**
   * Phase 0β provenance — files this run delivered to the inbox
   * (`~/.patchwork/inbox/`). One entry per `file.write` step whose
   * resolved path is inside the inbox dir; populated by yamlRunner.
   * Lets the dashboard link a run to its produced inbox items
   * without filename-string-munging. Optional + additive: pre-Phase-0β
   * runs simply omit it.
   */
  inboxOutputs?: Array<{ filename: string; deliveredAt: number }>;
  /**
   * Budget warnings surfaced by RunBudget at completion — warn-mode token
   * breaches and "driver X reports no usage, budget enforcement skipped"
   * notices. Previously computed and then discarded (RunBudget.warnings()
   * had no production reader); now persisted so the dashboard / `patchwork`
   * surfaces can show them. Additive: absent when the run set no budget or
   * tripped no warnings.
   */
  budgetWarnings?: string[];
  /**
   * P1 cost/token corpus — run-level aggregate of per-step agent token usage,
   * summed across all steps that reported usage. Present ONLY when at least
   * one step reported usage; absent for tool-only runs and runs served
   * entirely by unmeasured drivers. `costUsd` is the sum of the per-step
   * measured costs (priceable steps only) and is itself omitted when no step
   * was priceable. Additive + optional: pre-P1 rows round-trip unchanged.
   */
  tokenTotals?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /**
   * P1 — `RunBudget.totals()` snapshot at completion, persisted ONLY when a
   * budget was configured for the run (we never persist the all-zero no-budget
   * case, which would be misleading). Additive + optional.
   */
  budgetTotals?: import("./recipes/runBudget.js").BudgetTotals;
}

const MAX_OUTPUT_TAIL = 2_000;
const DEFAULT_MEMORY_CAP = 500;

/**
 * Disk rotation thresholds. The file grows append-only via `appendFileSync`
 * on every recipe run; without rotation a busy automation policy will fill
 * `~/.claude/ide/` over time and OOM the bridge at next boot via
 * `loadExisting`'s full `readFileSync`. We rotate at either limit, keeping
 * the most recent N lines.
 */
const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB
/**
 * Cap for `runs.jsonl.1`, the rotation archive. 8 MB ≈ eight rotations' worth
 * of recoverable history — enough that a rotation during an investigation does
 * not destroy the run being investigated, while still bounded on a laptop.
 */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/**
 * The identity of a run for dedup purposes: its `taskId`.
 *
 * Explicitly NOT `seq`. `seq` is a per-instance counter against a shared file
 * (eight construction sites, several writing), so unrelated runs collide on it
 * routinely — 142 of 145 seqs in the live log, with the colliding runs a median
 * 20 minutes apart. Keying on it silently deleted two-thirds of the run history,
 * which is also the autonomy gate's evidence.
 *
 * The `seq:` fallback covers rows written before `taskId` existed. It keeps an
 * old log deduping by its only available key rather than treating every row as
 * a distinct run — wrong in the other direction, but wrong quietly and in the
 * shape it already had.
 */
function runKey(r: RecipeRun): string {
  return r.taskId ? `task:${r.taskId}` : `seq:${r.seq}`;
}

/**
 * Is the process that owns a running row still alive?
 *
 * `kill(pid, 0)` sends no signal — it only asks whether the pid is addressable.
 * `EPERM` means the process exists but belongs to another user, which is still
 * alive for our purposes.
 *
 * An ABSENT stamp returns false (⇒ sweep). Rows predating `ownerPid` must keep
 * being recovered, and "we don't know" is not evidence of a live owner.
 *
 * The residual risk is pid reuse: an unrelated process inheriting a dead
 * bridge's pid leaves a run stuck `"running"` forever. That is the direction to
 * fail in — a visibly stuck row is recoverable and obvious, whereas the
 * alternative silently rewrites a completed run's history, which is the bug
 * being fixed.
 */
function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Union of a run's own step list and the recovered in-flight rows, keyed by
 * step id. The persisted row wins on a tie: the in-memory list of an
 * interrupted run is whatever the crashed process last managed to hand over,
 * and the ledger row is what actually reached disk.
 */
function mergeStepResults(
  existing: RunStepResult[] | undefined,
  recovered: RunStepResult[],
): RunStepResult[] {
  const byId = new Map<string, RunStepResult>();
  for (const s of existing ?? []) if (s?.id) byId.set(s.id, s);
  for (const s of recovered) if (s?.id) byId.set(s.id, s);
  return Array.from(byId.values());
}
/** Disk-retention line cap. Exported so a reader that must see the FULL retained
 *  history (e.g. worker trust replay) can size its in-memory ring to match the
 *  disk, instead of being silently bounded by DEFAULT_MEMORY_CAP. */
export const MAX_PERSIST_LINES = 10_000;

export interface RunLogOptions {
  /** Directory holding runs.jsonl. Created if missing. */
  dir: string;
  logger?: Logger;
  /** Cap on in-memory ring. File is not truncated. */
  memoryCap?: number;
  /** Test hook — default Date.now. */
  now?: () => number;
}

export interface RunQuery {
  limit?: number;
  trigger?: RunTrigger;
  status?: RunStatus;
  recipe?: string;
  /** Runs with seq > after. */
  after?: number;
  /** Only return runs with createdAt >= since (ms epoch). */
  since?: number;
  /** PR5c — exact-match on manualRunId. Yields all retries of one attempt. */
  manualRunId?: string;
}

// Minimum ms between disk-stat checks in syncFromDisk(). Dashboard
// auto-refresh hits query()/getBySeq() multiple times per second; each check
// was statSync + optional readFileSync. 250 ms is imperceptible for run-list
// freshness but reduces Defender/NTFS I/O by ~20× at steady state.
const _SYNC_MIN_INTERVAL_MS = 250;

export class RecipeRunLog {
  private runs: RecipeRun[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private lastFileSize = 0;
  private _lastSyncMs = 0;
  /** seq → step ids already written to the in-flight evidence ledger. Keeps
   *  `updateRunSteps` (which receives the FULL step list each call) from
   *  re-appending every prior step on every step completion. */
  private readonly persistedStepIds = new Map<number, Set<string>>();
  private readonly now: () => number;

  constructor(private readonly opts: RunLogOptions) {
    this.file = path.join(opts.dir, "runs.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      // 0o700 — restrict directory listing to the bridge's user. Without
      // an explicit mode here we fall through to the umask, which is
      // typically 0o022 → world-traversable dir. File entries are 0o600
      // so contents are safe; only listing leaks.
      mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      opts.logger?.warn?.(
        `[runlog] could not create ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loadExisting();
    try {
      this.lastFileSize = statSync(this.file).size;
    } catch {
      /* file may not exist */
    }
  }

  /**
   * Parse triggerSource into `{trigger, recipeName}`. Returns null for non-recipe
   * triggers (e.g. automation hooks like "onFileSave") so the caller can ignore them.
   */
  static parseTrigger(
    triggerSource: string | undefined,
  ): { trigger: RunTrigger; recipeName: string; parentSeq?: number } | null {
    if (!triggerSource) return null;
    // Format: "<kind>:<name>" or "<kind>:<name>:p<parentSeq>"
    // parentSeq suffix ":p<N>" is always at the end and uses a numeric-only value.
    const m = /^(cron|webhook|recipe):(.+?)(?::p(\d+))?$/.exec(triggerSource);
    if (!m?.[1] || !m[2]) return null;
    return {
      trigger: m[1] as RunTrigger,
      recipeName: m[2],
      ...(m[3] !== undefined && { parentSeq: parseInt(m[3], 10) }),
    };
  }

  record(task: {
    id: string;
    triggerSource?: string;
    status: string;
    createdAt: number;
    startedAt?: number;
    doneAt?: number;
    model?: string;
    output?: string;
    errorMessage?: string;
  }): RecipeRun | null {
    const parsed = RecipeRunLog.parseTrigger(task.triggerSource);
    if (!parsed) return null;
    const status = task.status as RunStatus;
    if (
      status !== "done" &&
      status !== "error" &&
      status !== "cancelled" &&
      status !== "interrupted"
    ) {
      return null;
    }
    const doneAt = task.doneAt ?? this.now();
    const startedAt = task.startedAt;
    const durationMs = doneAt - (startedAt ?? task.createdAt);
    this.seq += 1;
    const run: RecipeRun = {
      seq: this.seq,
      taskId: task.id,
      recipeName: parsed.recipeName,
      trigger: parsed.trigger,
      status,
      createdAt: task.createdAt,
      ...(startedAt !== undefined && { startedAt }),
      doneAt,
      ...(task.model !== undefined && { model: task.model }),
      ...(task.output !== undefined && {
        outputTail: task.output.slice(-MAX_OUTPUT_TAIL),
      }),
      ...(task.errorMessage !== undefined && {
        errorMessage: task.errorMessage,
      }),
      durationMs,
      ...(parsed.parentSeq !== undefined && { parentSeq: parsed.parentSeq }),
    };
    this.runs.push(run);
    if (this.runs.length > this.memoryCap) {
      this.runs.splice(0, this.runs.length - this.memoryCap);
    }
    this.append(run);
    return run;
  }

  query(q: RunQuery = {}): RecipeRun[] {
    this.syncFromDisk();
    const trigger = q.trigger;
    const status = q.status;
    const recipe = q.recipe;
    const manualRunId = q.manualRunId;
    const after = q.after;
    const since = q.since;
    const out: RecipeRun[] = [];
    for (const r of this.runs) {
      if (trigger && r.trigger !== trigger) continue;
      if (status && r.status !== status) continue;
      if (recipe && r.recipeName !== recipe) continue;
      if (manualRunId && r.manualRunId !== manualRunId) continue;
      if (after !== undefined && r.seq <= after) continue;
      if (since !== undefined && r.createdAt < since) continue;
      out.push(r);
    }
    // Newest first.
    out.sort((a, b) => b.seq - a.seq);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    return out.slice(0, limit);
  }

  /**
   * Return a single run by its monotonic seq, or null if not found.
   *
   * Fast path: in-memory ring lookup (the latest `memoryCap` runs).
   * Slow path: scan `runs.jsonl` once when the seq isn't in memory —
   * this is what makes older runs (evicted from the ring buffer)
   * accessible. The dashboard's `/runs/<seq>` page would otherwise
   * 404 for any recipe older than the last `memoryCap` (default 500).
   *
   * The on-disk scan reads the whole file but doesn't allocate the
   * full set in memory: we parse line-by-line and short-circuit on
   * the first match. Malformed lines are skipped silently, matching
   * `loadExisting` / `syncFromDisk` behaviour.
   */
  getBySeq(seq: number): RecipeRun | null {
    this.syncFromDisk();
    const inMem = this.runs.find((r) => r.seq === seq);
    if (inMem) return inMem;
    return this.readFromDiskBySeq(seq);
  }

  /** Return seqs of all in-memory runs whose parentSeq matches this seq. */
  getChildSeqs(parentSeq: number): number[] {
    this.syncFromDisk();
    const result: number[] = [];
    for (const r of this.runs) {
      if (r.parentSeq === parentSeq) result.push(r.seq);
    }
    return result;
  }

  private readFromDiskBySeq(seq: number): RecipeRun | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as RecipeRun;
        if (parsed.seq === seq) return parsed;
      } catch {
        // skip malformed line — never let one bad row break lookup
      }
    }
    return null;
  }

  /**
   * Runs that rotation moved into `runs.jsonl.1`, newest last. Empty when no
   * archive exists.
   *
   * Read directly from disk and NOT merged into the in-memory ring: the ring
   * backs the dashboard's run list, which wants the live window, whereas the
   * trust replay wants every run it can still prove happened. Folding the
   * archive into the ring would change what every display path shows in order
   * to serve one reader.
   *
   * This is a TRUST-path accessor. `runs.jsonl` is capped by bytes while the
   * durability window is defined in time, so a busy log can rotate a worker's
   * filing away before it ever settles — 18.2h of retention against a 24h
   * window, when this was found. #1334 stopped rotation deleting those rows;
   * this is the half that reads them back.
   */
  readArchive(): RecipeRun[] {
    const archive = `${this.file}.1`;
    let raw: string;
    try {
      raw = readFileSync(archive, "utf-8");
    } catch {
      return []; // absent is the normal case
    }
    const byKey = new Map<string, RecipeRun>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as RecipeRun;
        if (typeof parsed.seq !== "number") continue;
        byKey.set(runKey(parsed), parsed);
      } catch {
        /* skip malformed */
      }
    }
    return Array.from(byKey.values());
  }

  /** Test/inspection helper — current in-memory size. */
  size(): number {
    return this.runs.length;
  }

  /** Write a run directly (e.g. from yamlRunner which has no orchestrator task). */
  appendDirect(run: Omit<RecipeRun, "seq">): void {
    const seq = ++this.seq;
    // Derive hadStepErrors the same way completeRun does, so the
    // CLI / no-orchestrator path stays consistent with the bridge path.
    const hadStepErrors = (run.stepResults ?? []).some(
      (s) => s.status === "error",
    );
    const full: RecipeRun = { ...run, seq, hadStepErrors };
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.append(full);
    this.runs.push(full);
    if (this.runs.length > this.memoryCap) this.runs.shift();
  }

  /**
   * Begin a run. Allocates a monotonic seq, adds an in-memory entry with
   * `status: "running"`, persists it to disk immediately, and returns the seq
   * so the caller can correlate step events. Persisting on start (rather than
   * only on completion) means a bridge restart leaves a recoverable
   * `status: "interrupted"` record instead of silently vanishing the run.
   * Use `completeRun(seq, …)` when the run finishes to append the terminal
   * record; `loadExisting()` sweeps any leftover `"running"` rows on startup.
   */
  startRun(opts: {
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
  }): number {
    const seq = ++this.seq;
    const run: RecipeRun = {
      ownerPid: opts.ownerPid ?? process.pid,
      seq,
      taskId: opts.taskId,
      recipeName: opts.recipeName,
      trigger: opts.trigger,
      status: "running",
      createdAt: opts.createdAt,
      ...(opts.startedAt !== undefined && { startedAt: opts.startedAt }),
      ...(opts.model !== undefined && { model: opts.model }),
      // doneAt + durationMs are placeholders until completeRun fires —
      // dashboard treats `status:"running"` as the source of truth.
      doneAt: opts.createdAt,
      durationMs: 0,
      stepResults: [],
      ...(opts.parentSeq !== undefined && { parentSeq: opts.parentSeq }),
      ...(opts.manualRunId !== undefined && { manualRunId: opts.manualRunId }),
    };
    this.runs.push(run);
    if (this.runs.length > this.memoryCap) this.runs.shift();
    this.append(run);
    return seq;
  }

  /**
   * Replace the in-memory step list for a running entry. Called as steps
   * complete so the dashboard's `/runs/[seq]` page can render progress
   * without waiting for `completeRun`. No-op if the seq is unknown or
   * already terminal.
   */
  updateRunSteps(seq: number, stepResults: RunStepResult[]): void {
    const idx = this.runs.findIndex((r) => r.seq === seq);
    if (idx === -1) return;
    const run = this.runs[idx];
    if (!run || run.status !== "running") return;
    this.runs[idx] = { ...run, stepResults: [...stepResults] };
    this.persistInFlightEvidence(this.runs[idx], stepResults);
  }

  /**
   * Write the evidence-bearing steps of a still-running run to the sibling
   * step ledger, so an interruption before `completeRun` no longer erases the
   * record of actions that already happened. Only the steps this instance has
   * not already written, and only the ones that carry evidence — see
   * `isEvidenceBearing`. Rows land in `run_steps.jsonl`, never in `runs.jsonl`,
   * because that file's byte cap is what starved the trust ledger.
   */
  private persistInFlightEvidence(
    run: RecipeRun,
    stepResults: RunStepResult[],
  ): void {
    if (!run.taskId) return; // no join key ⇒ nothing to fold it back onto
    let written = this.persistedStepIds.get(run.seq);
    if (!written) {
      written = new Set();
      this.persistedStepIds.set(run.seq, written);
    }
    for (const step of stepResults) {
      if (!step?.id || written.has(step.id)) continue;
      if (!isEvidenceBearing(step)) continue;
      written.add(step.id);
      appendStepEvidence(
        this.opts.dir,
        {
          taskId: run.taskId,
          seq: run.seq,
          recipeName: run.recipeName,
          at: this.now(),
          step,
        },
        this.opts.logger,
      );
    }
  }

  /**
   * Finalize a running entry: update status + duration, append step results,
   * and persist the row to JSONL. No-op if the seq is unknown (e.g. the run
   * was started in a previous process before a restart) or already terminal.
   *
   * `opts.tokenTotals` / `opts.budgetTotals` MUST be threaded through
   * explicitly from the caller — do not drop them in a refactor. This file
   * has **two independent consumers**: the dashboard/CLI (cost reporting)
   * and the worker-autonomy trust-replay system (`src/workers/`), which
   * reads `runs.jsonl` as its outcome corpus. Audit 2026-06-09 (data-loss-1)
   * found these two fields silently missing from the `completeRun` opts
   * type, so runs persisted with no cost/budget data even though both were
   * computed upstream. Fixed, but a future signature change here can
   * reintroduce the same silent gap for both consumers at once.
   *
   * @param seq - The run's monotonic sequence id, from `startRun`.
   * @param opts.tokenTotals - Run-level token/cost aggregate; omit only when
   *   no step reported usage. See `RecipeRun.tokenTotals`.
   * @param opts.budgetTotals - `RunBudget.totals()` snapshot; omit only when
   *   no budget was configured for the run. See `RecipeRun.budgetTotals`.
   */
  completeRun(
    seq: number,
    opts: {
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
    },
  ): void {
    const idx = this.runs.findIndex((r) => r.seq === seq);
    if (idx === -1) return;
    const prev = this.runs[idx];
    if (!prev || prev.status !== "running") return;
    const finalized: RecipeRun = {
      ...prev,
      status: opts.status,
      doneAt: opts.doneAt,
      durationMs: opts.durationMs,
      stepResults: opts.stepResults,
      // Derived, single source of truth: a run with any error-status
      // step "completed with errors" even if its terminal status is
      // `done` (the runner continues past non-fatal step errors).
      hadStepErrors: opts.stepResults.some((s) => s.status === "error"),
      ...(opts.outputTail !== undefined && { outputTail: opts.outputTail }),
      ...(opts.errorMessage !== undefined && {
        errorMessage: opts.errorMessage,
      }),
      ...(opts.assertionFailures !== undefined && {
        assertionFailures: opts.assertionFailures,
      }),
      ...(opts.inboxOutputs !== undefined &&
        opts.inboxOutputs.length > 0 && {
          inboxOutputs: opts.inboxOutputs,
        }),
      ...(opts.budgetWarnings !== undefined &&
        opts.budgetWarnings.length > 0 && {
          budgetWarnings: opts.budgetWarnings,
        }),
      ...(opts.tokenTotals !== undefined && { tokenTotals: opts.tokenTotals }),
      ...(opts.budgetTotals !== undefined && {
        budgetTotals: opts.budgetTotals,
      }),
    };
    this.runs[idx] = finalized;
    // The terminal row now carries the full step list, so the in-flight
    // tracking for this run is dead weight. (The ledger's own rows age out via
    // its size cap — they are only ever read for runs still marked "running".)
    this.persistedStepIds.delete(seq);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.append(finalized);
  }

  private append(run: RecipeRun): void {
    try {
      // Per-file lock — ADR-0007 multi-bridge concurrency. See the
      // matching block in src/decisionTraceLog.ts for the full
      // rationale; same pattern.
      //
      // core-infra-2: rotation MUST happen under the same advisory lock as
      // the append. If rotateDisk() runs before the lock is acquired, a
      // concurrent bridge can appendFileSync between the .tmp write and the
      // renameSync — that row lands on the file about to be atomically
      // replaced and is lost. Re-stat under the lock so the rotation
      // decision is also serialized with respect to other writers.
      withFileLockSync(this.file, () => {
        // Rotate first if the file is over the limit. Cheap stat call; only
        // rewrites when needed. Without this, runs.jsonl grows unbounded.
        try {
          const st = statSync(this.file);
          if (st.size > MAX_PERSIST_BYTES) this.rotateDisk();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw err;
        }
        appendFileSync(this.file, `${JSON.stringify(run)}\n`, { mode: 0o600 });
      });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[runlog] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Trim runs.jsonl to the most recent MAX_PERSIST_LINES (or whatever
   * fits under MAX_PERSIST_BYTES). Lines beyond the cap are dropped from
   * disk; in-memory `runs[]` is unaffected (separately bounded by
   * memoryCap). Best-effort — failure is logged and the next append
   * proceeds against the un-rotated file.
   */
  /**
   * Append rows being trimmed by rotation to `runs.jsonl.1`, and say so.
   *
   * Bounded: when the archive itself passes `MAX_ARCHIVE_BYTES` its own oldest
   * rows are dropped — genuinely, this time. An unbounded archive on a laptop
   * is its own failure, so the choice is deliberate and the warning says which
   * kind of loss happened. Best-effort throughout: a failed archive write must
   * never prevent the rotation that keeps the live file bounded.
   */
  private archiveDropped(dropped: string[]): void {
    const archive = `${this.file}.1`;
    try {
      let existing = "";
      try {
        existing = readFileSync(archive, "utf8");
      } catch {
        /* no archive yet */
      }
      let lines = [...existing.split("\n").filter((l) => l.trim()), ...dropped];
      let joined = lines.join("\n");
      let archiveTrimmed = 0;
      while (joined.length + 1 > MAX_ARCHIVE_BYTES && lines.length > 1) {
        const keep = Math.max(1, Math.floor(lines.length / 2));
        archiveTrimmed += lines.length - keep;
        lines = lines.slice(-keep);
        joined = lines.join("\n");
      }
      writeFileSync(archive, joined.length > 0 ? `${joined}\n` : "", {
        mode: 0o600,
      });
      this.opts.logger?.warn?.(
        `[runlog] rotate moved ${dropped.length} row(s) to ${path.basename(archive)}` +
          (archiveTrimmed > 0
            ? ` — and dropped ${archiveTrimmed} row(s) from the archive (over ${MAX_ARCHIVE_BYTES} bytes); trust evidence older than that is gone`
            : ""),
      );
    } catch (err) {
      this.opts.logger?.warn?.(
        `[runlog] rotate DROPPED ${dropped.length} row(s) — archive write failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private rotateDisk(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const original = raw.split("\n").filter((l) => l.trim());
      let lines = original;
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      let joined = lines.join("\n");
      while (joined.length + 1 > MAX_PERSIST_BYTES && lines.length > 1) {
        lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
        joined = lines.join("\n");
      }
      // Everything about to be trimmed. This file is the autonomy gate's TRUST
      // LEDGER, not only a display log, so dropping rows here silently deletes
      // the evidence a worker's earned autonomy rests on — and in-memory state
      // is unaffected, so nothing looks wrong at runtime. On 2026-08-11 this
      // destroyed the first successful governed errand between one read of the
      // file and the next. The durable mitigation (`worker_trust/` checkpoints)
      // has never written a file, so nothing stood behind it.
      //
      // Archive rather than delete. This makes the loss RECOVERABLE; it does
      // not make it invisible to the dial, which reads only the live file —
      // preventing that is the checkpoint's job, separately.
      const dropped = original.slice(0, original.length - lines.length);
      if (dropped.length > 0) this.archiveDropped(dropped);
      // If we're down to a single line that still exceeds the cap, drop it
      // entirely. Without this guard the while-loop exits at length===1 and
      // we'd write an oversized row back, defeating rotation. A realistic
      // offender is `RunStepResult.registrySnapshot` which is unbounded
      // user JSON.
      if (lines.length === 1 && joined.length + 1 > MAX_PERSIST_BYTES) {
        this.opts.logger?.warn?.(
          `[runlog] rotate dropped 1 oversized row (${joined.length} bytes > ${MAX_PERSIST_BYTES} cap)`,
        );
        lines = [];
        joined = "";
      }
      // Atomic write: temp file + rename. Crash / ENOSPC mid-write
      // would otherwise truncate the entire run-log file at the source
      // path. Matches the pattern used in sessionCheckpoint.write().
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, joined.length > 0 ? `${joined}\n` : "", {
        mode: 0o600,
      });
      // On Windows renameSync throws EEXIST when target exists; POSIX replaces atomically.
      try {
        renameSync(tmp, this.file);
      } catch (renameErr) {
        if (
          process.platform === "win32" &&
          (renameErr as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          try {
            unlinkSync(this.file);
          } catch {
            /* best-effort */
          }
          renameSync(tmp, this.file);
        } else {
          throw renameErr;
        }
      }
      // Refresh `lastFileSize` so the next syncFromDisk() doesn't see
      // `size <= lastFileSize` (stale pre-rotation value) and silently
      // skip freshly-appended rows.
      try {
        this.lastFileSize = statSync(this.file).size;
      } catch {
        this.lastFileSize = 0;
      }
    } catch (err) {
      this.opts.logger?.warn?.(
        `[runlog] rotate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Incrementally read any new lines appended to the file since last load. */
  private syncFromDisk(): void {
    // `this.now()` (defaults to Date.now), not Date.now directly — the class
    // already takes an injectable clock and reaching past it made the sync
    // throttle untestable, so a test asserting freshness could only ever pass
    // by accident of timing.
    const now = this.now();
    if (now - this._lastSyncMs < _SYNC_MIN_INTERVAL_MS) return;
    this._lastSyncMs = now;
    try {
      const sizeBefore = statSync(this.file).size;
      // core-infra-1: rotation detection. If the file shrank below the
      // last-seen size, another bridge rotated (truncated/replaced) it —
      // reset the cursor so we re-read the rotated content from scratch
      // instead of treating the smaller post-rotation size as "no new
      // rows" (which would silently skip every row after rotation).
      if (sizeBefore < this.lastFileSize) this.lastFileSize = 0;
      if (sizeBefore <= this.lastFileSize) return;
      const raw = readFileSync(this.file, "utf-8");
      const lines = raw.split("\n");
      // Upsert by taskId. This used to gate on `parsed.seq > this.seq`, which
      // meant a CONCURRENT writer's run was invisible to this instance for as
      // long as it stayed up — its seqs are drawn from an independent counter,
      // so they are routinely equal to or below ours and every such row was
      // silently skipped. That is a separate loss from the load-time dedup: it
      // discarded runs as they ARRIVED, not merely on re-read.
      const index = new Map<string, number>();
      for (let i = 0; i < this.runs.length; i++) {
        const r = this.runs[i];
        if (r) index.set(runKey(r), i);
      }
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as RecipeRun;
          if (typeof parsed.seq !== "number") continue;
          if (parsed.seq > this.seq) this.seq = parsed.seq;
          const key = runKey(parsed);
          const at = index.get(key);
          if (at !== undefined) {
            // A row for a run we already hold. Take it only when it represents
            // PROGRESS, never when it would rewind.
            //
            // `updateRunSteps` mutates the in-memory row; it writes only
            // EVIDENCE-BEARING steps to the sibling step ledger, and never
            // rewrites this run's row in `runs.jsonl`. So a live run's full
            // step list still exists only here (the ledger is a crash-recovery
            // subset, folded in at load, not a mirror). Blindly
            // replacing with the on-disk row would wipe the progress the
            // dashboard is streaming. The old `seq > this.seq` gate protected
            // this by accident (it skipped every existing run); removing that
            // gate to see concurrent writers means the protection has to be
            // stated on purpose.
            const held = this.runs[at];
            const heldIsLive = held?.status === "running";
            const parsedIsTerminal = parsed.status !== "running";
            if (!heldIsLive || parsedIsTerminal) this.runs[at] = parsed;
            continue;
          }
          index.set(key, this.runs.length);
          this.runs.push(parsed);
          if (this.runs.length > this.memoryCap) {
            this.runs.shift();
            // Indices shifted by one — rebuild rather than track an offset.
            index.clear();
            for (let i = 0; i < this.runs.length; i++) {
              const r = this.runs[i];
              if (r) index.set(runKey(r), i);
            }
          }
        } catch {
          /* skip malformed */
        }
      }
      // core-infra-1: re-stat AFTER readFileSync and store the SMALLER of
      // the pre- and post-read sizes. If the file was rotated between the
      // initial stat and the read, the pre-read size reflects the larger
      // pre-rotation file; storing it would make the next sync see
      // `newSize <= lastFileSize` and skip rows appended after rotation.
      // Using the post-read size (clamped to the read) keeps lastFileSize
      // consistent with the bytes we actually consumed.
      let sizeAfter = sizeBefore;
      try {
        sizeAfter = statSync(this.file).size;
      } catch {
        /* file vanished between read and re-stat — keep sizeBefore */
      }
      this.lastFileSize = Math.min(sizeBefore, sizeAfter);
    } catch {
      /* file may not exist yet */
    }
  }

  private loadExisting(): void {
    try {
      statSync(this.file);
    } catch {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch (err) {
      this.opts.logger?.warn?.(
        `[runlog] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as RecipeRun;
        if (typeof parsed.seq !== "number") continue;
        // Seed in-memory ring from tail so dashboard has immediate history.
        this.runs.push(parsed);
        if (parsed.seq > this.seq) this.seq = parsed.seq;
      } catch {
        // skip malformed line — never let one bad row break startup
      }
    }
    // Dedup by taskId, keeping the latest-appended row per run. The append-only
    // log writes multiple rows per run (running → terminal), and the sweep below
    // historically appended a fresh "interrupted" row each restart; without this,
    // query()/getBySeq return stale/duplicate rows after a restart.
    //
    // NOT by seq. `seq` is a per-INSTANCE counter (see `private seq`) but this
    // file is shared by eight construction sites, several of which write, so two
    // instances alive at once hand the same seq to unrelated runs. Deduping by it
    // therefore DELETED runs: in the live log 142 of 145 seqs were shared, and
    // 463 real runs collapsed to 146 visible ones. Since this file is also the
    // trust ledger, two-thirds of the autonomy gate's evidence was being
    // discarded on every read.
    //
    // taskId is safe as a key: across that same log no taskId disagreed with
    // itself on `createdAt`, and none spanned two recipes. Fall back to the seq
    // for any row predating taskId, so an old log still dedups rather than
    // multiplying.
    const byTask = new Map<string, RecipeRun>();
    for (const r of this.runs) byTask.set(runKey(r), r);
    const deduped = Array.from(byTask.values()).sort(
      (a, b) => a.seq - b.seq || a.createdAt - b.createdAt,
    );
    this.runs.length = 0;
    this.runs.push(...deduped);
    if (this.runs.length > this.memoryCap) {
      this.runs.splice(0, this.runs.length - this.memoryCap);
    }
    // Sweep: a run still `status:"running"` after loading was interrupted by a
    // bridge restart. Flip in memory and append the corrected terminal record
    // so future reads see "interrupted" instead of a permanently-stuck entry.
    //
    // ONLY when its owning process is provably gone. This ran unconditionally,
    // in the constructor, against a file eight construction sites share — so a
    // `patchwork` CLI verb or a dashboard poll declared a live sibling's runs
    // dead. The damage was not cosmetic: `syncFromDisk` hands the terminal row
    // back to the owning bridge (terminal beats live, by design) and
    // `completeRun` no-ops on a non-running row, so the real completion was
    // never written and a SUCCESSFUL run recorded `interrupted`, zero steps.
    const now = this.now();
    // Fold in-flight evidence back onto the runs it belongs to. Read lazily —
    // most restarts sweep nothing, and this is startup path.
    let evidence: Map<string, RunStepResult[]> | null = null;
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i];
      if (!run || run.status !== "running") continue;
      if (isProcessAlive(run.ownerPid)) continue;
      evidence ??= loadStepEvidence(this.opts.dir, this.opts.logger);
      const recovered = run.taskId ? evidence.get(run.taskId) : undefined;
      const interrupted: RecipeRun = {
        ...run,
        status: "interrupted",
        doneAt: now,
        durationMs: now - run.createdAt,
        ...(recovered?.length
          ? { stepResults: mergeStepResults(run.stepResults, recovered) }
          : {}),
      };
      this.runs[i] = interrupted;
      this.append(interrupted);
    }
  }
}
