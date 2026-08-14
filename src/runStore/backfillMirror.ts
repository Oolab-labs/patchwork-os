/**
 * Backfill and compare the ADR-0022 shadow mirror.
 *
 * ## Why backfill has to come first
 *
 * `runs.jsonl` already holds the installation's history — 1,123 rows on the
 * machine this was written for. The mirror starts empty. Enable the mirror and
 * compare immediately and every pre-existing row reports as a difference:
 * ~1,123 findings, all expected, none meaningful. A divergence signal that
 * always fires is indistinguishable from one that never does, and it teaches
 * whoever reads it to stop.
 *
 * So the mirror is seeded from the authoritative file FIRST, and only then is
 * a disagreement worth reporting.
 *
 * ## Backfill is also the rehearsal
 *
 * This is the migration performed in miniature: read every row the old store
 * holds, write it to the new one, then check they agree. If the database
 * cannot reproduce the history the file already has, the plan is dead — and
 * that is much better learned now than at the flip.
 *
 * ## What it does not do
 *
 * It does not modify `runs.jsonl` in any way. Backfill is read-only with
 * respect to the source of truth, and the mirror remains something nothing
 * reads for answers.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RecipeRun } from "../runLog.js";
import { MAX_PERSIST_LINES, RecipeRunLog } from "../runLog.js";
import { diffRun } from "./dualWriteRunRepository.js";
import type { SqliteRunRepository } from "./sqliteRunRepository.js";

export interface BackfillResult {
  /** Rows read from the authoritative store (live file + rotation archive). */
  sourceRows: number;
  /** Rows written to the mirror. */
  written: number;
  /** Distinct runs in the mirror afterwards. */
  mirrorRows: number;
  /**
   * Raw lines in the authoritative file, versus the distinct runs in
   * `sourceRows`.
   *
   * These differ a lot and it is NOT loss: the run log appends a "running"
   * row and later a terminal row for the same task, and every JSONL reader
   * takes the last. On the live log 1,123 lines are 424 runs. Reported so the
   * numbers reconcile rather than looking like the mirror dropped two-thirds
   * of the history.
   *
   * An earlier version of this counted collapses during the write loop and
   * could only ever report 0, because the reader dedupes upstream. A field
   * that structurally cannot fire is worse than no field.
   */
  rawSourceLines: number;
}

export interface CompareResult {
  /** Runs present in the authoritative store. */
  sourceRows: number;
  /** Runs present in the mirror. */
  mirrorRows: number;
  /** Runs in the source with no counterpart in the mirror. */
  missingFromMirror: string[];
  /** Runs in the mirror with no counterpart in the source. */
  onlyInMirror: string[];
  /** Per-run field disagreements, `taskId` → differences. */
  fieldDifferences: Array<{ taskId: string; differences: string[] }>;
  /** True when the two stores agree on every run and every compared field. */
  agree: boolean;
}

/** Raw non-blank lines across the live file and its rotation archive. Counted
 *  from disk because every reader dedupes by taskId before anything can see
 *  the original row count. */
function countRawLines(dir: string): number {
  let n = 0;
  for (const f of ["runs.jsonl", "runs.jsonl.1"]) {
    const p = path.join(dir, f);
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        if (line.trim()) n++;
      }
    } catch {
      // Unreadable archive must not fail a backfill; the count is context,
      // not a correctness signal.
    }
  }
  return n;
}

/** Read every run the authoritative store retains — live file AND the rotation
 *  archive, because the archive is still evidence the trust replay reads. */
export function readAuthoritative(dir: string): RecipeRun[] {
  const log = new RecipeRunLog({ dir, memoryCap: MAX_PERSIST_LINES });
  try {
    // Archive first, then live: later rows win on taskId collision, which is
    // the same precedence every JSONL reader already applies.
    return [...log.readArchive(), ...log.query({ limit: MAX_PERSIST_LINES })];
  } finally {
    log.close();
  }
}

/**
 * Seed the mirror from the authoritative store. Idempotent — rows upsert by
 * `taskId`, so running it twice is a no-op rather than a duplication.
 */
export function backfillMirror(
  dir: string,
  mirror: SqliteRunRepository,
): BackfillResult {
  const rows = readAuthoritative(dir);
  let written = 0;
  for (const run of rows) {
    if (!run?.taskId) continue;
    mirror.mirrorRow(run);
    written++;
  }
  return {
    sourceRows: rows.length,
    written,
    mirrorRows: mirror.size(),
    rawSourceLines: countRawLines(dir),
  };
}

/**
 * Compare the two stores run by run.
 *
 * Keyed on `taskId`, never `seq`: `seq` is a per-instance counter that
 * collided on 142 of 145 rows in the live log (#1324), so comparing by it
 * would pair unrelated runs and report differences between two things that
 * were never the same run.
 */
export function compareStores(
  dir: string,
  mirror: SqliteRunRepository,
): CompareResult {
  const source = readAuthoritative(dir);
  // Later row wins, matching JSONL read precedence.
  const sourceById = new Map<string, RecipeRun>();
  for (const r of source) if (r?.taskId) sourceById.set(r.taskId, r);

  const mirrorRuns = mirror.query({ limit: MAX_PERSIST_LINES });
  const mirrorById = new Map(mirrorRuns.map((r) => [r.taskId, r]));

  const missingFromMirror: string[] = [];
  const fieldDifferences: CompareResult["fieldDifferences"] = [];
  for (const [taskId, s] of sourceById) {
    const m = mirrorById.get(taskId);
    if (!m) {
      missingFromMirror.push(taskId);
      continue;
    }
    const differences = diffRun(s, m);
    if (differences.length > 0) fieldDifferences.push({ taskId, differences });
  }
  const onlyInMirror = [...mirrorById.keys()].filter(
    (id) => !sourceById.has(id),
  );

  return {
    sourceRows: sourceById.size,
    mirrorRows: mirrorById.size,
    missingFromMirror,
    onlyInMirror,
    fieldDifferences,
    agree:
      missingFromMirror.length === 0 &&
      onlyInMirror.length === 0 &&
      fieldDifferences.length === 0,
  };
}

/** Operator-facing rendering. Silence on agreement would be ambiguous with a
 *  broken command, so agreement is stated explicitly. */
export function formatCompare(r: CompareResult): string {
  const lines: string[] = [];
  lines.push(
    `Authoritative (runs.jsonl): ${r.sourceRows} run(s)   Mirror (runs.db): ${r.mirrorRows} run(s)`,
  );
  if (r.agree) {
    lines.push("");
    lines.push("The two stores AGREE on every run and every compared field.");
    return `${lines.join("\n")}\n`;
  }
  if (r.missingFromMirror.length > 0) {
    lines.push("");
    lines.push(`Missing from the mirror (${r.missingFromMirror.length}):`);
    for (const id of r.missingFromMirror.slice(0, 10)) lines.push(`  ${id}`);
    if (r.missingFromMirror.length > 10)
      lines.push(`  … and ${r.missingFromMirror.length - 10} more`);
  }
  if (r.onlyInMirror.length > 0) {
    lines.push("");
    lines.push(`Only in the mirror (${r.onlyInMirror.length}):`);
    for (const id of r.onlyInMirror.slice(0, 10)) lines.push(`  ${id}`);
    if (r.onlyInMirror.length > 10)
      lines.push(`  … and ${r.onlyInMirror.length - 10} more`);
  }
  if (r.fieldDifferences.length > 0) {
    lines.push("");
    lines.push(`Field differences (${r.fieldDifferences.length} run(s)):`);
    for (const d of r.fieldDifferences.slice(0, 10)) {
      lines.push(`  ${d.taskId}`);
      for (const diff of d.differences) lines.push(`    ${diff}`);
    }
    if (r.fieldDifferences.length > 10)
      lines.push(`  … and ${r.fieldDifferences.length - 10} more run(s)`);
  }
  return `${lines.join("\n")}\n`;
}
