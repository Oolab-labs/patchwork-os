import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { appendChained, isChainMarker } from "./ledgerChain.js";
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
  /** Writer-stamped record level. Absent on rows that predate the chain. */
  rv?: number;
  /** ADR-0027 integrity position and previous-line hash (rv >= 1). */
  iseq?: number;
  prev?: string;
}

/**
 * Record level (ADR-0025's `rv` protocol; ADR-0027 for this ledger).
 *
 * 1: every row is written through `appendChained` and carries `iseq` and
 * `prev`, stamped by the writer from the file's tail under the lock. At
 * `rv >= 1` their absence is a WRITER DEFECT. Rows with no `rv` predate the
 * chain; they are never re-stamped, and the `chain-start` marker commits to
 * them as a block. Never default it on read.
 */
export const RUN_STEP_LEDGER_RV = 1;

/** Cap on `run_steps.jsonl`. Rows only matter until their run reaches a
 *  terminal record, so this is a crash-window buffer, not history. */
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
/**
 * Low-water target after rotation. Half the cap keeps the old "newest half
 * survives" bound while letting the primitive trim to a byte target rather
 * than a line ratio; a target at the cap would rotate on every append once
 * the file is full (the gate ledger measured 826 rotations in one fill).
 */
const ROTATE_TARGET_BYTES = MAX_LEDGER_BYTES / 2;

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
 *  take down the run that produced it.
 *
 *  ADR-0027: one locked, chained append. The hand-rolled "drop half the file
 *  at 2 MB" trim is gone; rotation is the primitive's, writes an explicit
 *  `rotation` marker, and the chain re-anchors across it. A failed append is
 *  counted in the `.write_failed` sidecar and sealed into the next row, so a
 *  ledger that stopped writing is distinguishable from a quiet run.
 *
 *  `opts.maxBytes` is a TEST SEAM (like the gate ledger's `maxPersistBytes`):
 *  a test that must observe rotation should not write two real megabytes. */
export function appendStepEvidence(
  dir: string,
  row: RunStepLedgerRow,
  logger?: Logger,
  opts: { maxBytes?: number } = {},
): void {
  const file = stepLedgerPath(dir);
  const maxBytes = opts.maxBytes ?? MAX_LEDGER_BYTES;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendChained(
      file,
      // Stamped AFTER the caller's fields so a caller cannot claim a level.
      { ...row, rv: RUN_STEP_LEDGER_RV } as unknown as Record<string, unknown>,
      {
        mode: 0o600,
        maxBytes,
        rotateTarget:
          opts.maxBytes !== undefined
            ? Math.floor(maxBytes / 2)
            : ROTATE_TARGET_BYTES,
        onRotate: ({ dropped, before }) => {
          logger?.warn?.(
            `[runsteps] rotate dropped ${dropped} of ${before} row(s) (oldest first) to get under ${maxBytes} bytes`,
          );
        },
      },
    );
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
      // ADR-0027 marker rows are metadata, never step evidence — skipped by
      // KIND, so a marker that happened to carry a taskId could not sneak in.
      if (isChainMarker(parsed)) continue;
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
