/**
 * Older-than paging over the run log — the cursor and the list projection
 * behind `GET /runs?before=…`.
 *
 * ## Why the cursor is `(createdAt, runKey)` and not `seq`
 *
 * `seq` is a per-INSTANCE counter, and `runs.jsonl` is shared by every process
 * that constructs a run log, so two live instances hand the same `seq` to
 * unrelated runs (#1324 — 142 of 145 seqs collided in one live log). A
 * "seq < N" cursor would therefore skip or repeat runs at every collision.
 *
 * A run's identity is its `taskId` (`runKey` falls back to `seq:` only for
 * rows that predate `taskId`). Identity alone is not orderable, so the cursor
 * pairs it with `createdAt`, which is fixed for the life of a run — no taskId
 * has been observed disagreeing with itself on it. Ordering is
 * `createdAt DESC, runKey DESC`: a strict total order over distinct runs, so a
 * page boundary that falls between two runs created in the same millisecond
 * loses neither.
 *
 * The encoding is opaque on purpose (`v1.` + base64url JSON). Callers must
 * round-trip `nextBefore` rather than build one, so the key can change behind
 * a new version prefix without a URL contract break.
 */

import type { RecipeRun, RunStatus, RunTrigger } from "./runLog.js";

export interface RunCursor {
  createdAt: number;
  /** `runKey(run)` — `task:<taskId>`, or `seq:<n>` for pre-taskId rows. */
  key: string;
}

/** Projection for list views. `summary` omits `stepResults`. */
export type RunFields = "summary";

export interface RunPageQuery {
  /** Strictly older than this. `null` ⇒ start from the newest run. */
  before: RunCursor | null;
  limit?: number;
  trigger?: RunTrigger;
  status?: RunStatus;
  recipe?: string;
  manualRunId?: string;
  fields?: RunFields;
}

/** A run row, optionally projected: summary rows carry `stepCount` instead of `stepResults`. */
export type RunPageRow = Omit<RecipeRun, "stepResults"> & {
  stepResults?: RecipeRun["stepResults"];
  stepCount?: number;
};

export interface RunPage {
  runs: RunPageRow[];
  /** Cursor for the next (older) page, or `null` when nothing older matches. */
  nextBefore: string | null;
}

const CURSOR_VERSION = "v1.";
/** A real cursor is well under 200 chars; anything far beyond is not one. */
const MAX_CURSOR_LENGTH = 1024;

export function encodeRunCursor(c: RunCursor): string {
  return (
    CURSOR_VERSION +
    Buffer.from(JSON.stringify([c.createdAt, c.key]), "utf-8").toString(
      "base64url",
    )
  );
}

/** Parse a cursor; `null` for anything that is not one we issued. */
export function decodeRunCursor(raw: string): RunCursor | null {
  if (raw.length > MAX_CURSOR_LENGTH) return null;
  if (!raw.startsWith(CURSOR_VERSION)) return null;
  const body = raw.slice(CURSOR_VERSION.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [createdAt, key] = parsed as [unknown, unknown];
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  return { createdAt, key };
}

/** `createdAt` as an orderable number — a malformed row sorts as oldest. */
export function runCreatedAt(r: Pick<RecipeRun, "createdAt">): number {
  return typeof r.createdAt === "number" && Number.isFinite(r.createdAt)
    ? r.createdAt
    : 0;
}

/** Compare two sort keys, newest first (negative ⇒ `a` comes first). */
export function compareNewestFirst(a: RunCursor, b: RunCursor): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

/** Is `k` strictly older than the cursor (i.e. after it, newest-first)? */
export function isOlderThan(k: RunCursor, cursor: RunCursor | null): boolean {
  return cursor === null || compareNewestFirst(k, cursor) > 0;
}

/**
 * The list projection: drop `stepResults` (the bulk of a row — each step can
 * carry 8 KB of captured output) and keep how many there were. A row with no
 * `stepResults` is returned unchanged, so absent stays absent rather than
 * becoming `stepCount: 0`.
 */
export function summarizeRun<T extends { stepResults?: unknown }>(
  r: T,
): Omit<T, "stepResults"> & { stepCount?: number } {
  if (!Object.hasOwn(r, "stepResults")) return r;
  const { stepResults, ...rest } = r;
  return Array.isArray(stepResults)
    ? { ...rest, stepCount: stepResults.length }
    : rest;
}
