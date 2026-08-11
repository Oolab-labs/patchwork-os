import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DURABILITY_WINDOW_MS } from "./shadowObserver.js";

/**
 * How far back the run log actually reaches, measured against the durability
 * window a non-reversible success must survive before it counts as evidence.
 *
 * WHY THIS EXISTS. `runs.jsonl` is capped by BYTES; the durability window is
 * defined in TIME, and nothing reconciled the two. One high-frequency recipe
 * (1243 of 1275 rows in 18.2 hours, on the machine where this was found) can
 * consume the entire budget, so a worker's filing is deleted BEFORE it can
 * settle. Trust on compensable and irreversible actions was then unearnable in
 * principle rather than merely slow — the action is withheld while provisional,
 * then gone before the window elapses.
 *
 * The read-side version of this exact bug was already fixed once (see the ring
 * `memoryCap` note in runWorkerShadow.ts: "a low-frequency worker's evidence
 * ages out behind unrelated high-frequency recipe traffic"). That fix was
 * correct and the same failure survived one layer down, in disk retention,
 * because nothing measured whether the invariant actually held. This module is
 * that measurement: it does not fix retention, it makes the cliff SAYABLE, so
 * the next regression is noticed by someone other than an investigation.
 */
export interface EvidenceRetention {
  /** Oldest run timestamp found, or null when the log is empty. */
  oldestAt: number | null;
  /** Newest run timestamp found, or null when the log is empty. */
  newestAt: number | null;
  /** How much wall-clock the retained evidence spans. */
  spanMs: number;
  /** The durability window the span is being judged against. */
  windowMs: number;
  /** Rows counted across the live log and its rotation archive. */
  rows: number;
  /**
   * False only when there IS evidence and it spans less than the durability
   * window. An empty log is a new install, not a starved ledger — reporting it
   * as a cliff would cry wolf on every fresh machine and train people to
   * ignore the warning that matters.
   */
  sufficient: boolean;
  /** One-line operator-facing summary. */
  summary: string;
}

function timestampsIn(file: string): number[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as {
        createdAt?: number;
        doneAt?: number;
        startedAt?: number;
      };
      const at = r.doneAt ?? r.startedAt ?? r.createdAt;
      if (typeof at === "number" && Number.isFinite(at) && at > 0) out.push(at);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const hrs = (ms: number): string => `${Math.round(ms / 3_600_000)}h`;

/**
 * Measure retention across the live run log AND its rotation archive
 * (`runs.jsonl.1`), since #1334 moves trimmed rows there rather than deleting
 * them and the trust replay now reads both.
 */
export function evidenceRetention(
  patchworkDir: string,
  opts: { now?: number; windowMs?: number } = {},
): EvidenceRetention {
  const windowMs = opts.windowMs ?? DEFAULT_DURABILITY_WINDOW_MS;
  const ts = [
    ...timestampsIn(path.join(patchworkDir, "runs.jsonl")),
    ...timestampsIn(path.join(patchworkDir, "runs.jsonl.1")),
  ];
  if (ts.length === 0) {
    return {
      oldestAt: null,
      newestAt: null,
      spanMs: 0,
      windowMs,
      rows: 0,
      sufficient: true,
      summary: "No runs recorded yet — nothing to retain.",
    };
  }
  const oldestAt = Math.min(...ts);
  const newestAt = Math.max(...ts);
  const spanMs = newestAt - oldestAt;
  const sufficient = spanMs >= windowMs;
  return {
    oldestAt,
    newestAt,
    spanMs,
    windowMs,
    rows: ts.length,
    sufficient,
    summary: sufficient
      ? `Run history spans ${hrs(spanMs)}, clearing the ${hrs(windowMs)} durability window (${ts.length} rows).`
      : `Run history spans only ${hrs(spanMs)} against a ${hrs(windowMs)} durability window (${ts.length} rows). ` +
        "A non-reversible success is deleted before it can settle, so those action classes cannot earn trust at all. " +
        "Usually one high-frequency recipe is consuming the log's byte budget.",
  };
}
