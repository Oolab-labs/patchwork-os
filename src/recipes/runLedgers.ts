/**
 * Per-attempt ledger storage for automated recipe runs.
 *
 * INV-1 made `fs-write` reversible only when a rollback pre-image is confirmed,
 * and automated runs had no rollback store at all. This gives every logical
 * attempt its OWN directory under `run-ledgers/`, holding that attempt's
 * `file_rollback.jsonl` and write-effect ledger:
 *
 *   - no cross-run eviction — one run's pre-images cannot be trimmed away by
 *     unrelated later runs, which a single shared capped file allowed;
 *   - the same webhook delivery (or cron slot) resolves to the same store, so
 *     redelivery dedup and resume keep working;
 *   - retention is whole-run: a store is deleted in one piece, never thinned.
 *
 * The directory name is `deriveScopeKey(recipeName, attemptId)` — an opaque
 * hash, so neither a recipe name nor a webhook-supplied delivery id reaches
 * the filesystem path.
 *
 * "Reversible at execution" and "rollback available now" are different facts:
 * after retention expires the run WAS reversible when it ran, but the store
 * that made it so is gone, and `recipe rollback --run` says so.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { patchworkPath } from "../patchworkHome.js";
import { deriveScopeKey } from "./idempotencyKey.js";

export const RUN_LEDGERS_DIRNAME = "run-ledgers";
const RUNS_INDEX = "runs.jsonl";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Default root: `$PATCHWORK_HOME/run-ledgers`. */
export function runLedgersRoot(): string {
  return patchworkPath(RUN_LEDGERS_DIRNAME);
}

/**
 * The logical attempt identity, used as `manualRunId`. Stable for a webhook
 * delivery and for a cron slot (so a redelivery or a retried tick is the same
 * attempt); fresh otherwise. Always satisfies the manualRunId contract.
 */
export function attemptIdFor(opts: {
  deliveryId?: string;
  cronSlotEpochMs?: number;
}): string {
  if (opts.deliveryId !== undefined) {
    const raw = `webhook-${opts.deliveryId}`;
    if (SAFE_ID.test(raw)) return raw;
    const h = createHash("sha256")
      .update(opts.deliveryId)
      .digest("hex")
      .slice(0, 40);
    return `webhook-h-${h}`;
  }
  if (opts.cronSlotEpochMs !== undefined) {
    return `cron-${Math.floor(opts.cronSlotEpochMs / 60_000) * 60_000}`;
  }
  return `once-${randomUUID()}`;
}

export function attemptLedgerDir(
  root: string,
  recipeName: string,
  attemptId: string,
): string {
  return path.join(root, deriveScopeKey(recipeName, attemptId));
}

/**
 * Create (or reuse) the attempt's store. Returns `undefined` when it cannot be
 * created or written — the caller then passes NO ledger dir, so every file
 * write in the run assesses `unavailable` and is gated as irreversible. Never
 * falls back to a shared or temporary location.
 */
export function prepareAttemptLedger(
  root: string,
  recipeName: string,
  attemptId: string,
): string | undefined {
  try {
    const dir = attemptLedgerDir(root, recipeName, attemptId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) return undefined;
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    return undefined;
  }
}

export interface AttemptRunRecord {
  runTaskId: string;
  recipeName: string;
  attemptId: string;
}

/** Index a run into its store so rollback can be found by run identity. */
export function recordAttemptRun(dir: string, rec: AttemptRunRecord): void {
  try {
    appendFileSync(
      path.join(dir, RUNS_INDEX),
      `${JSON.stringify({ ...rec, recordedAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* fail-soft: the store still works; only run-based lookup is lost */
  }
}

export function findAttemptByRun(
  root: string,
  runTaskId: string,
): { dir: string; recipeName: string; attemptId: string } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    const idx = path.join(dir, RUNS_INDEX);
    if (!existsSync(idx)) continue;
    let raw: string;
    try {
      raw = readFileSync(idx, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as Partial<AttemptRunRecord>;
        if (
          r.runTaskId === runTaskId &&
          typeof r.recipeName === "string" &&
          typeof r.attemptId === "string"
        ) {
          return { dir, recipeName: r.recipeName, attemptId: r.attemptId };
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return undefined;
}

/** Newest mtime of the dir and anything directly inside it. */
function lastTouched(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const f of readdirSync(dir)) {
    try {
      t = Math.max(t, statSync(path.join(dir, f)).mtimeMs);
    } catch {
      /* raced away */
    }
  }
  return t;
}

/**
 * Whole-run GC: delete stores untouched for longer than `retentionMs`. Never a
 * store named in `active`. Returns how many stores were removed.
 */
export function gcRunLedgers(
  root: string,
  opts: { retentionMs: number; now?: number; active?: ReadonlySet<string> },
): number {
  const now = opts.now ?? Date.now();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (opts.active?.has(name)) continue;
    const dir = path.join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) continue;
      if (now - lastTouched(dir) <= opts.retentionMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* fail-soft: GC must never break a run */
    }
  }
  return removed;
}

/**
 * The ONE place an automated run's attempt store is chosen — used by
 * `fireYamlRecipe` and by tests that mirror it, so they cannot drift.
 * `ledgerDir` is absent when the store could not be created (fail closed).
 */
export function attemptStoreFor(
  recipeName: string,
  opts: { deliveryId?: string; cronSlotEpochMs?: number },
  root: string = runLedgersRoot(),
): { attemptId: string; ledgerDir?: string } {
  const attemptId = attemptIdFor(opts);
  const ledgerDir = prepareAttemptLedger(root, recipeName, attemptId);
  return ledgerDir ? { attemptId, ledgerDir } : { attemptId };
}
