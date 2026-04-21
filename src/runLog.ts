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
export type RunStatus = "done" | "error" | "cancelled" | "interrupted";

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
