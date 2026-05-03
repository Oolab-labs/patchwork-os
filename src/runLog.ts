import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  /** seq of the parent run that triggered this one, if trigger === "recipe". */
  parentSeq?: number;
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

/**
 * Disk rotation thresholds. The file grows append-only via `appendFileSync`
 * on every recipe run; without rotation a busy automation policy will fill
 * `~/.claude/ide/` over time and OOM the bridge at next boot via
 * `loadExisting`'s full `readFileSync`. We rotate at either limit, keeping
 * the most recent N lines.
 */
const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB
const MAX_PERSIST_LINES = 10_000;

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

  /** Return seqs of all in-memory runs whose parentSeq matches this seq. */
  getChildSeqs(parentSeq: number): number[] {
    this.syncFromDisk();
    return this.runs.filter((r) => r.parentSeq === parentSeq).map((r) => r.seq);
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
    parentSeq?: number;
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
      ...(opts.parentSeq !== undefined && { parentSeq: opts.parentSeq }),
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
  private rotateDisk(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      let lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      let joined = lines.join("\n");
      while (joined.length + 1 > MAX_PERSIST_BYTES && lines.length > 1) {
        lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
        joined = lines.join("\n");
      }
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
      writeFileSync(this.file, joined.length > 0 ? `${joined}\n` : "", {
        mode: 0o600,
      });
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
