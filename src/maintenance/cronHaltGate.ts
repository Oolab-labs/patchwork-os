/**
 * The third `sweep` gate: a scheduled recipe that used to work and now fails.
 *
 * On 2026-10-14 the hourly privacy heartbeat on the reference install began
 * failing every run (the local model it named had been removed) and nothing
 * surfaced it for 30 hours. `halts` could see it, but `halts` answers a
 * question somebody has to ask; `sweep` is the verb that runs unasked. Every
 * one of the 24 runs on the following day was `error`.
 *
 * ## The rule, decided and deliberately narrow
 *
 * A cron-triggered recipe whose runs were `done` for at least seven
 * consecutive days and whose most recent six or more runs are all `error`
 * is FAILING. The gate is healthy when no recipe is in that state. A recipe
 * with fewer than seven days of history is not eligible — it has no "used to
 * work" to flip from, and a baseline is not a flip, the same distinction the
 * sweep itself draws on its first run.
 *
 * Why both halves. Six errors alone would fire on a brand-new recipe that
 * never worked; that is a defect, but it is not THIS defect, and it is already
 * visible on the run page the moment anyone installs it. Seven clean days
 * alone would fire on one bad hour. Together they describe the failure that
 * went unnoticed: something that had earned the right to be ignored, and then
 * quietly stopped.
 *
 * ## Counts in the snapshot, names in the inbox
 *
 * The snapshot row is counts only — how many recipes are failing, how many
 * were eligible — because `sweep_snapshots.jsonl` must never accumulate
 * operator data. The recipe name and the first failing run time go to ONE
 * inbox note, written when the gate flips and not again while it stays
 * failing, because a note per sweep is a note nobody reads.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isReplayRun, type RecipeRun, RecipeRunLog } from "../runLog.js";
import type { SweepDelta } from "./sweep.js";

/** Days of consecutive `done` runs a recipe needs before it can flip. */
export const CRON_HALT_MIN_CLEAN_DAYS = 7;
/** Consecutive `error` runs, most recent first, that constitute the flip. */
export const CRON_HALT_MIN_ERROR_STREAK = 6;
/** Gate key in the sweep reading. */
export const CRON_HALT_GATE = "cronHalts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The slice of a run row this gate reads. */
export type CronRunRow = Pick<
  RecipeRun,
  "taskId" | "recipeName" | "trigger" | "status" | "createdAt" | "doneAt"
>;

export interface FailingRecipe {
  recipeName: string;
  /** `createdAt` of the first run in the trailing error streak. */
  firstFailureAt: number;
  /** Length of the trailing error streak. */
  errorStreak: number;
  /** Span of the `done` runs immediately before the streak, in ms. */
  cleanSpanMs: number;
}

export interface CronHaltAssessment {
  /** Cron recipes with at least `CRON_HALT_MIN_CLEAN_DAYS` of clean history. */
  eligible: number;
  failing: FailingRecipe[];
}

/**
 * Pure: decide which cron recipes are in the failing state. Rows may arrive in
 * any order and may include non-cron or non-terminal rows; both are ignored.
 */
export function assessCronHalts(
  rows: CronRunRow[],
  _opts: { now: number },
): CronHaltAssessment {
  const byRecipe = new Map<string, CronRunRow[]>();
  for (const r of rows) {
    if (r.trigger !== "cron") continue;
    if (r.status !== "done" && r.status !== "error") continue;
    const list = byRecipe.get(r.recipeName) ?? [];
    list.push(r);
    byRecipe.set(r.recipeName, list);
  }
  let eligible = 0;
  const failing: FailingRecipe[] = [];
  for (const [recipeName, list] of byRecipe) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    // Trailing error streak, newest backwards.
    let i = list.length - 1;
    let errorStreak = 0;
    while (i >= 0 && list[i]?.status === "error") {
      errorStreak++;
      i--;
    }
    // The `done` run immediately before the streak, walking back while done.
    const lastClean = i;
    while (i >= 0 && list[i]?.status === "done") i--;
    const firstClean = i + 1;
    const cleanSpanMs =
      lastClean >= firstClean
        ? (list[lastClean] as CronRunRow).createdAt -
          (list[firstClean] as CronRunRow).createdAt
        : 0;
    if (cleanSpanMs < CRON_HALT_MIN_CLEAN_DAYS * DAY_MS) continue;
    eligible++;
    if (errorStreak < CRON_HALT_MIN_ERROR_STREAK) continue;
    failing.push({
      recipeName,
      firstFailureAt: (list[lastClean + 1] as CronRunRow).createdAt,
      errorStreak,
      cleanSpanMs,
    });
  }
  failing.sort((a, b) => a.recipeName.localeCompare(b.recipeName));
  return { eligible, failing };
}

/**
 * Terminal cron runs from the run log and its rotation archive, through the
 * same reader `workers shadow` uses: `RecipeRunLog` dedups by `taskId`
 * (never `seq`, #1324) and the archive is merged the same way, so a run that
 * rotated out is still history and a run written twice is still one run.
 * Replay rows are not runs the scheduler started.
 *
 * Returns an empty list when there is no log to read; the caller treats that
 * as a reading it could not take, not as a healthy gate.
 */
export function readCronRuns(dir: string): CronRunRow[] {
  if (
    !existsSync(path.join(dir, "runs.jsonl")) &&
    !existsSync(path.join(dir, "runs.jsonl.1"))
  ) {
    return [];
  }
  // A cap large enough that one busy recipe cannot evict another's history
  // before it is read; the default (500) is sized for a dashboard ring.
  const log = new RecipeRunLog({ dir, memoryCap: 50_000 });
  const merged = new Map<string, RecipeRun>();
  for (const r of [...log.readArchive(), ...log.query({ limit: 500 })]) {
    merged.set(r.taskId ? `task:${r.taskId}` : `seq:${r.seq}`, r);
  }
  // `query` clamps at 500 rows overall; re-query per cron recipe so a busy
  // install does not truncate the recipe this gate is watching.
  const names = new Set<string>();
  for (const r of merged.values())
    if (r.trigger === "cron") names.add(r.recipeName);
  for (const recipe of names) {
    for (const r of log.query({ recipe, trigger: "cron", limit: 500 })) {
      merged.set(r.taskId ? `task:${r.taskId}` : `seq:${r.seq}`, r);
    }
  }
  const out: CronRunRow[] = [];
  for (const r of merged.values()) {
    if (r.trigger !== "cron" || isReplayRun(r)) continue;
    if (r.status !== "done" && r.status !== "error") continue;
    out.push({
      taskId: r.taskId,
      recipeName: r.recipeName,
      trigger: r.trigger,
      status: r.status,
      createdAt: r.createdAt,
      doneAt: r.doneAt,
    });
  }
  return out;
}

/** The log exists (live or archive), so a reading can be taken. */
export function cronRunLogPresent(dir: string): boolean {
  return (
    existsSync(path.join(dir, "runs.jsonl")) ||
    existsSync(path.join(dir, "runs.jsonl.1"))
  );
}

/**
 * Write the inbox note for a flip of the cron-halt gate, and only for a flip:
 * the previous snapshot carried the gate as healthy and this reading does not.
 * A first sweep, a gate the previous snapshot never had, and a gate that is
 * still failing all write nothing. Returns the path written, or undefined.
 *
 * The note carries the same run header a recipe's `file.write` to the inbox
 * gets (`recipe` / `trigger` / `deliveredAt`), so the inbox lists it like any
 * other delivery. There is no `runSeq`: a sweep is not a run.
 */
export function noteCronHaltFlip(opts: {
  delta: SweepDelta;
  assessment: CronHaltAssessment;
  inbox: string;
  now: number;
}): string | undefined {
  const flipped = opts.delta.gates.some(
    (g) => g.key === CRON_HALT_GATE && g.regression,
  );
  if (!flipped || opts.assessment.failing.length === 0) return undefined;
  const stamp = new Date(opts.now).toISOString();
  const lines = [
    "---",
    "recipe: sweep",
    "trigger: manual",
    `deliveredAt: ${stamp}`,
    "---",
    "",
    "# A scheduled recipe used to work and is now failing",
    "",
    `\`patchwork sweep\` found ${opts.assessment.failing.length} cron recipe(s) that ran \`done\` for at least ${CRON_HALT_MIN_CLEAN_DAYS} days and whose latest ${CRON_HALT_MIN_ERROR_STREAK}+ runs are all \`error\`.`,
    "",
  ];
  for (const f of opts.assessment.failing) {
    lines.push(
      `- **${f.recipeName}** — first failing run ${new Date(f.firstFailureAt).toISOString()}, ${f.errorStreak} consecutive errors after ${Math.floor(f.cleanSpanMs / DAY_MS)} clean days.`,
    );
  }
  lines.push(
    "",
    "Run `patchwork halts --window 7d --recipe <name>` for the error messages, then `patchwork recipe doctor`.",
    "",
  );
  mkdirSync(opts.inbox, { recursive: true, mode: 0o700 });
  const file = path.join(
    opts.inbox,
    `sweep-cron-halt-${stamp.replace(/[:.]/g, "-")}.md`,
  );
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  return file;
}
