/**
 * The SQLite run store — ADR-0022.
 *
 * Held to the SAME contract as the JSONL incumbent
 * (`describeRunRepositoryContract`), which is the entire point: the migration's
 * safety argument is "this behaves like the store we already trust", and that
 * is only checkable if one set of assertions covers both.
 *
 * ## Why SQLite at all
 *
 * `runs.jsonl` is the autonomy gate's trust evidence and an append-only text
 * file with no integrity properties. It failed three ways in eight weeks, each
 * silently — #1324 (`seq` collides across processes), #1340 (in-flight steps
 * never written), #1341 (a concurrent reader made `completeRun` a no-op). The
 * fixes grew a file lock, byte AND line caps, an archive tier and an upsert
 * reconciliation path into `runLog.ts`: a database, reimplemented, losing.
 * `runLog.ts:753` documents a lost write we chose to live with.
 *
 * ## Identity
 *
 * `task_id` is the PRIMARY KEY, not `seq`. That is the #1324 fix landing as a
 * schema constraint rather than a convention: `seq` is a PER-INSTANCE counter
 * handed out by eight construction sites, so 142 of 145 seqs in the live log
 * were shared by unrelated runs. Here the database refuses to store two runs
 * under one identity, instead of a reader silently discarding one.
 *
 * `seq` is still carried, still per-instance, and `getBySeq` is still
 * ambiguous — preserved deliberately, because a migration that also changes the
 * domain model cannot be verified by comparing old against new. #1360 fixes
 * that separately, once the stores agree.
 *
 * ## What is NOT here
 *
 * No byte cap, no line cap, no rotation, no archive tier. Retention becomes a
 * policy decision against a queryable store rather than a byte budget fighting
 * a 24-hour durability window — which is the collision that starved the trust
 * ledger. Nothing calls this yet; dual-write and shadow-read come next.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import type {
  RecipeRun,
  RunQuery,
  RunStatus,
  RunStepResult,
  RunTrigger,
} from "../runLog.js";
import { isEvidenceBearing } from "../runStepLedger.js";
import type {
  CompleteRunInput,
  RunRepository,
  StartRunInput,
} from "./runRepository.js";

export interface SqliteRunStoreOptions {
  /** Directory holding runs.db. Created if missing. */
  dir: string;
  logger?: Logger;
  /** Test hook — default Date.now. */
  now?: () => number;
  /** Test seam for liveness. Default: real process check. */
  isAlive?: (pid: number | undefined) => boolean;
}

/**
 * Is the process that owns a running row still alive?
 *
 * Byte-for-byte the same rule as `runLog.ts`, including its judgement calls:
 * `EPERM` counts as alive (the process exists, it just belongs to someone
 * else), and an ABSENT pid returns false so rows predating `ownerPid` keep
 * being recovered. "We don't know" is not evidence of a live owner.
 *
 * Divergence here would be invisible and would desynchronise the two stores
 * during dual-write in the one area — sweeping live runs — that #1341 proves
 * is dangerous.
 */
function defaultIsAlive(pid: number | undefined): boolean {
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  task_id         TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL,
  recipe_name     TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  done_at         INTEGER,
  duration_ms     INTEGER,
  model           TEXT,
  output_tail     TEXT,
  error_message   TEXT,
  parent_seq      INTEGER,
  manual_run_id   TEXT,
  owner_pid       INTEGER,
  had_step_errors INTEGER,
  step_results    TEXT,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS runs_seq        ON runs(seq);
CREATE INDEX IF NOT EXISTS runs_parent     ON runs(parent_seq);
CREATE INDEX IF NOT EXISTS runs_recipe     ON runs(recipe_name);

-- In-flight evidence. Separate table for the same reason #1340 used a separate
-- FILE: these rows arrive per step, and mixing them into the run record made
-- durability compete with retention.
CREATE TABLE IF NOT EXISTS run_steps (
  task_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  step    TEXT NOT NULL,
  PRIMARY KEY (task_id, step_id)
);
`;

/** Columns carried verbatim as JSON rather than promoted to columns. Nothing
 *  queries them; giving each a column would be schema churn for no reader. */
const EXTRA_KEYS = [
  "assertionFailures",
  "inboxOutputs",
  "budgetWarnings",
  "tokenTotals",
  "budgetTotals",
] as const;

type Row = Record<string, unknown>;

export class SqliteRunRepository implements RunRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly isAlive: (pid: number | undefined) => boolean;
  private seq = 0;

  constructor(private readonly opts: SqliteRunStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(opts.dir, "runs.db"));
    // WAL: a reader must not block the writer, and vice versa. The whole
    // reason this store exists is that eight construction sites touch one
    // ledger concurrently.
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    this.seq = this.maxSeq();
    this.sweepInterrupted();
  }

  close(): void {
    this.db.close();
  }

  private maxSeq(): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM runs").get() as Row;
    return typeof r?.m === "number" ? r.m : 0;
  }

  /**
   * Flip runs whose owning process is provably gone to `interrupted`, folding
   * in the evidence they managed to persist.
   *
   * ONLY when the owner is gone. Running this unconditionally is exactly
   * #1341: a concurrent reader declared a live sibling's runs dead, and because
   * `completeRun` no-ops on a non-running row, the real completion was never
   * written — a successful run recorded `interrupted, steps: 0`.
   */
  private sweepInterrupted(): void {
    const rows = this.db
      .prepare(
        "SELECT task_id, owner_pid, created_at FROM runs WHERE status='running'",
      )
      .all() as Row[];
    const now = this.now();
    const flip = this.db.prepare(
      "UPDATE runs SET status='interrupted', done_at=?, duration_ms=?, step_results=? WHERE task_id=?",
    );
    for (const r of rows) {
      const pid = typeof r.owner_pid === "number" ? r.owner_pid : undefined;
      if (this.isAlive(pid)) continue;
      const taskId = String(r.task_id);
      const createdAt = Number(r.created_at);
      const recovered = this.stepsFor(taskId);
      flip.run(
        now,
        now - createdAt,
        recovered.length > 0 ? JSON.stringify(recovered) : null,
        taskId,
      );
    }
  }

  private stepsFor(taskId: string): RunStepResult[] {
    const rows = this.db
      .prepare(
        "SELECT step FROM run_steps WHERE task_id=? ORDER BY at ASC, rowid ASC",
      )
      .all(taskId) as Row[];
    const out: RunStepResult[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(String(r.step)) as RunStepResult);
      } catch {
        // A single unparseable row must not destroy the rest of a run's
        // evidence — the failure mode this whole subsystem exists to prevent.
        this.opts.logger?.warn?.(
          `[sqlite-runstore] skipping unparseable step row for ${taskId}`,
        );
      }
    }
    return out;
  }

  private rowToRun(r: Row): RecipeRun {
    const extra = r.extra ? (JSON.parse(String(r.extra)) as Row) : {};
    const steps = r.step_results
      ? (JSON.parse(String(r.step_results)) as RunStepResult[])
      : undefined;
    const run: RecipeRun = {
      seq: Number(r.seq),
      taskId: String(r.task_id),
      recipeName: String(r.recipe_name),
      trigger: String(r.trigger) as RunTrigger,
      status: String(r.status) as RunStatus,
      createdAt: Number(r.created_at),
      doneAt: Number(r.done_at ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      ...(r.started_at != null && { startedAt: Number(r.started_at) }),
      ...(r.model != null && { model: String(r.model) }),
      ...(r.output_tail != null && { outputTail: String(r.output_tail) }),
      ...(r.error_message != null && { errorMessage: String(r.error_message) }),
      ...(r.parent_seq != null && { parentSeq: Number(r.parent_seq) }),
      ...(r.manual_run_id != null && { manualRunId: String(r.manual_run_id) }),
      ...(r.owner_pid != null && { ownerPid: Number(r.owner_pid) }),
      ...(r.had_step_errors != null && {
        hadStepErrors: Boolean(r.had_step_errors),
      }),
      ...(steps ? { stepResults: steps } : {}),
      ...extra,
    };
    return run;
  }

  startRun(input: StartRunInput): number {
    const seq = ++this.seq;
    this.db
      .prepare(
        `INSERT INTO runs (task_id, seq, recipe_name, trigger, status, created_at,
                           started_at, model, parent_seq, manual_run_id, owner_pid)
         VALUES (?,?,?,?,'running',?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           seq=excluded.seq, status='running', created_at=excluded.created_at,
           started_at=excluded.started_at, owner_pid=excluded.owner_pid`,
      )
      .run(
        input.taskId,
        seq,
        input.recipeName,
        input.trigger,
        input.createdAt,
        input.startedAt ?? null,
        input.model ?? null,
        input.parentSeq ?? null,
        input.manualRunId ?? null,
        input.ownerPid ?? process.pid,
      );
    return seq;
  }

  /** Resolve a per-instance `seq` to a task id. Ambiguous by construction — see
   *  the class docs and #1360. Newest wins, which is the least surprising of
   *  several wrong answers. */
  private taskIdForSeq(seq: number): string | null {
    const r = this.db
      .prepare(
        "SELECT task_id FROM runs WHERE seq=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(seq) as Row | undefined;
    return r ? String(r.task_id) : null;
  }

  updateRunSteps(seq: number, stepResults: RunStepResult[]): void {
    const taskId = this.taskIdForSeq(seq);
    if (!taskId) return;
    const cur = this.db
      .prepare("SELECT status FROM runs WHERE task_id=?")
      .get(taskId) as Row | undefined;
    if (!cur || cur.status !== "running") return;

    const now = this.now();
    const ins = this.db.prepare(
      "INSERT INTO run_steps (task_id, step_id, at, step) VALUES (?,?,?,?) ON CONFLICT(task_id, step_id) DO NOTHING",
    );
    for (const step of stepResults) {
      if (!step?.id) continue;
      // Same scope as the JSONL ledger: non-reversible, or any error. A
      // reversible step carries no trust evidence, and persisting everything
      // would buy durability with retention — the trade that starved the
      // ledger in the first place.
      if (!isEvidenceBearing(step)) continue;
      ins.run(taskId, step.id, now, JSON.stringify(step));
    }
  }

  completeRun(seq: number, input: CompleteRunInput): void {
    const taskId = this.taskIdForSeq(seq);
    if (!taskId) return;
    const cur = this.db
      .prepare("SELECT status FROM runs WHERE task_id=?")
      .get(taskId) as Row | undefined;
    // No-op on an already-terminal row, matching the incumbent.
    if (!cur || cur.status !== "running") return;

    const extra: Row = {};
    for (const k of EXTRA_KEYS) {
      const v = (input as unknown as Row)[k];
      if (v !== undefined) extra[k] = v;
    }
    const hadStepErrors = input.stepResults.some((s) => s?.status === "error");

    this.db
      .prepare(
        `UPDATE runs SET status=?, done_at=?, duration_ms=?, step_results=?,
                         output_tail=?, error_message=?, had_step_errors=?, extra=?
         WHERE task_id=?`,
      )
      .run(
        input.status,
        input.doneAt,
        input.durationMs,
        JSON.stringify(input.stepResults),
        input.outputTail ?? null,
        input.errorMessage ?? null,
        hadStepErrors ? 1 : 0,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        taskId,
      );
  }

  query(q: RunQuery = {}): RecipeRun[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.recipe !== undefined) {
      where.push("recipe_name = ?");
      args.push(q.recipe);
    }
    if (q.status !== undefined) {
      where.push("status = ?");
      args.push(q.status);
    }
    if (q.trigger !== undefined) {
      where.push("trigger = ?");
      args.push(q.trigger);
    }
    if (q.since !== undefined) {
      where.push("created_at >= ?");
      args.push(q.since);
    }
    if (q.after !== undefined) {
      where.push("seq > ?");
      args.push(q.after);
    }
    if (q.manualRunId !== undefined) {
      where.push("manual_run_id = ?");
      args.push(q.manualRunId);
    }
    const sql =
      `SELECT * FROM runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      // seq as tiebreak so equal createdAt still yields a deterministic order —
      // several contract cases share a timestamp.
      " ORDER BY created_at DESC, seq DESC" +
      (q.limit !== undefined ? " LIMIT ?" : "");
    if (q.limit !== undefined) args.push(q.limit);
    const rows = this.db.prepare(sql).all(...(args as never[])) as Row[];
    return rows.map((r) => this.rowToRun(r));
  }

  getBySeq(seq: number): RecipeRun | null {
    const r = this.db
      .prepare(
        "SELECT * FROM runs WHERE seq=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(seq) as Row | undefined;
    return r ? this.rowToRun(r) : null;
  }

  getChildSeqs(parentSeq: number): number[] {
    const rows = this.db
      .prepare("SELECT seq FROM runs WHERE parent_seq=? ORDER BY seq ASC")
      .all(parentSeq) as Row[];
    return rows.map((r) => Number(r.seq));
  }

  size(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as Row;
    return Number(r?.n ?? 0);
  }
}
