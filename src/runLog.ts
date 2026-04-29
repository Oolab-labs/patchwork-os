import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

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
  durationMs: number;
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
  /** Assertion failures from the recipe's expect block — present when assertions fail. */
  assertionFailures?: Array<{
    assertion: string;
    expected: unknown;
    actual: unknown;
    message: string;
  }>;
}

const MAX_OUTPUT_TAIL = 2_000;
const DEFAULT_MEMORY_CAP = 500;

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
}

export class RecipeRunLog {
  private runs: RecipeRun[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private lastFileSize = 0;
  private readonly now: () => number;

  constructor(private readonly opts: RunLogOptions) {
    this.file = path.join(opts.dir, "runs.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(opts.dir, { recursive: true });
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
  ): { trigger: RunTrigger; recipeName: string } | null {
    if (!triggerSource) return null;
    const m = /^(cron|webhook|recipe):(.+)$/.exec(triggerSource);
    if (!m?.[1] || !m[2]) return null;
    return { trigger: m[1] as RunTrigger, recipeName: m[2] };
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
    let out = this.runs;
    if (q.trigger) out = out.filter((r) => r.trigger === q.trigger);
    if (q.status) out = out.filter((r) => r.status === q.status);
    if (q.recipe) out = out.filter((r) => r.recipeName === q.recipe);
    if (q.after !== undefined) {
      const after = q.after;
      out = out.filter((r) => r.seq > after);
    }
    // Newest first.
    out = [...out].sort((a, b) => b.seq - a.seq);
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

  /** Test/inspection helper — current in-memory size. */
  size(): number {
    return this.runs.length;
  }

  /** Write a run directly (e.g. from yamlRunner which has no orchestrator task). */
  appendDirect(run: Omit<RecipeRun, "seq">): void {
    const seq = ++this.seq;
    const full: RecipeRun = { ...run, seq };
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.append(full);
    this.runs.push(full);
    if (this.runs.length > this.memoryCap) this.runs.shift();
  }

  /**
   * Begin a run. Allocates a monotonic seq, adds an in-memory entry with
   * `status: "running"`, and returns the seq so the caller can correlate
   * step events. The entry is NOT persisted to disk — running runs are
   * ephemeral and don't survive a bridge restart (recipes-in-flight don't
   * survive restart anyway). Use `completeRun(seq, …)` when the run finishes
   * to upgrade the entry to a terminal status and persist it.
   */
  startRun(opts: {
    taskId: string;
    recipeName: string;
    trigger: RunTrigger;
    createdAt: number;
    startedAt?: number;
    model?: string;
  }): number {
    const seq = ++this.seq;
    const run: RecipeRun = {
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
    };
    this.runs.push(run);
    if (this.runs.length > this.memoryCap) this.runs.shift();
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
  }

  /**
   * Finalize a running entry: update status + duration, append step results,
   * and persist the row to JSONL. No-op if the seq is unknown (e.g. the run
   * was started in a previous process before a restart).
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
      ...(opts.outputTail !== undefined && { outputTail: opts.outputTail }),
      ...(opts.errorMessage !== undefined && {
        errorMessage: opts.errorMessage,
      }),
      ...(opts.assertionFailures !== undefined && {
        assertionFailures: opts.assertionFailures,
      }),
    };
    this.runs[idx] = finalized;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.append(finalized);
  }

  private append(run: RecipeRun): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(run)}\n`, { mode: 0o600 });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[runlog] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Incrementally read any new lines appended to the file since last load. */
  private syncFromDisk(): void {
    try {
      const size = statSync(this.file).size;
      if (size <= this.lastFileSize) return;
      const raw = readFileSync(this.file, "utf-8");
      const lines = raw.split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as RecipeRun;
          if (typeof parsed.seq !== "number") continue;
          if (parsed.seq > this.seq) {
            this.seq = parsed.seq;
            this.runs.push(parsed);
            if (this.runs.length > this.memoryCap) this.runs.shift();
          }
        } catch {
          /* skip malformed */
        }
      }
      this.lastFileSize = size;
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
    if (this.runs.length > this.memoryCap) {
      this.runs.splice(0, this.runs.length - this.memoryCap);
    }
  }
}
