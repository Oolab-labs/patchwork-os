import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";
import type { RunStepResult } from "./runLog.js";
import { AGENT_STEP_TOOL, classifyActionClass } from "./workers/actionClass.js";

/**
 * In-flight evidence ledger — `run_steps.jsonl`, a sibling of `runs.jsonl`.
 *
 * A run's steps reached disk only when `completeRun` fired, so an interruption
 * erased the record of actions that had already happened. This file carries the
 * steps that MATTER between `startRun` and the terminal append; `RecipeRunLog`
 * folds them back onto the interrupted run at load, so every existing reader of
 * `runs.jsonl` (dashboard, trust replay) sees the evidence without learning
 * about a second file.
 *
 * Deliberately NOT written into `runs.jsonl`. That file is byte-capped, and its
 * budget is exactly what starved the trust ledger to a 17 h span against a 24 h
 * durability window — adding per-step writes to it would buy durability by
 * spending retention, which is the same evidence loss wearing different clothes.
 */
export interface RunStepLedgerRow {
  taskId: string;
  seq: number;
  recipeName: string;
  at: number;
  step: RunStepResult;
}

/** Cap on `run_steps.jsonl`. Rows only matter until their run reaches a
 *  terminal record, so this is a crash-window buffer, not history. */
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;

/**
 * Is this step worth persisting mid-flight?
 *
 * Only steps that carry evidence: a non-reversible action (it happened and
 * cannot simply be re-derived) or any error (the halt reason is the whole
 * point of the record). Reads are excluded because volume is the constraint.
 *
 * Agent steps are excluded on BOTH outcomes, matching #1320: the gate carves
 * them out as "not a gated action-class", and a failed agent step reports on a
 * model call, not on whether the worker can be trusted with a side effect.
 */
export function isEvidenceBearing(step: RunStepResult): boolean {
  if (step.tool === AGENT_STEP_TOOL) return false;
  if (step.status === "error") return true;
  if (!step.tool) return false;
  return classifyActionClass(step.tool).reversibility !== "reversible";
}

export function stepLedgerPath(dir: string): string {
  return path.join(dir, "run_steps.jsonl");
}

/** Append one evidence row. Never throws — losing a mid-flight row must not
 *  take down the run that produced it. */
export function appendStepEvidence(
  dir: string,
  row: RunStepLedgerRow,
  logger?: Logger,
): void {
  const file = stepLedgerPath(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    trimIfOversized(file);
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (err) {
    logger?.warn?.(
      `[runsteps] append failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the ledger, grouped by taskId, newest-wins per step id. Returns an empty
 * map when the file is missing or unreadable — fail-soft, exactly as before
 * this ledger existed.
 */
export function loadStepEvidence(
  dir: string,
  logger?: Logger,
): Map<string, RunStepResult[]> {
  const file = stepLedgerPath(dir);
  let raw: string;
  try {
    statSync(file);
    raw = readFileSync(file, "utf-8");
  } catch {
    return new Map();
  }
  const byTask = new Map<string, Map<string, RunStepResult>>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RunStepLedgerRow;
      if (!parsed?.taskId || !parsed.step?.id) continue;
      let steps = byTask.get(parsed.taskId);
      if (!steps) {
        steps = new Map();
        byTask.set(parsed.taskId, steps);
      }
      steps.set(parsed.step.id, parsed.step);
    } catch {
      // skip malformed row — one bad line must not hide the rest
      logger?.debug?.("[runsteps] skipped malformed row");
    }
  }
  const out = new Map<string, RunStepResult[]>();
  for (const [taskId, steps] of byTask)
    out.set(taskId, Array.from(steps.values()));
  return out;
}

/** Keep the newest half when the buffer exceeds its cap. */
function trimIfOversized(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= MAX_LEDGER_BYTES) return;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const keep = lines.slice(Math.floor(lines.length / 2));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, keep.length > 0 ? `${keep.join("\n")}\n` : "", {
    mode: 0o600,
  });
  renameSync(tmp, file);
}
