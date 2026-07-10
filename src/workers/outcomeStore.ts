import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Outcome disposition for a filed issue. Drives the trust signal the ramp
 * folds in once the durability window has elapsed:
 *
 *   confirmed — issue closed-as-completed or labelled valid. Strong positive:
 *               the worker's filing was real and accepted. Counts as good:true
 *               with full weight (same as today, but now human-verified).
 *   junk      — issue closed-as-not-planned, labelled invalid/duplicate/wontfix,
 *               or otherwise dismissed. Strong negative: the worker filed noise.
 *               Flipped to good:false in trust-replay — junk must lower trust,
 *               not be neutral (surviving 24h unopened ≠ correctness).
 *   unknown   — issue still open past the window, or no signal yet. WITHHELD —
 *               not folded as evidence at all (an unactioned filing must not
 *               earn trust just by sitting unopened; trust-by-neglect fix,
 *               #1064). A null return from getDisposition is treated identically.
 */
export type OutcomeDisposition = "confirmed" | "junk" | "unknown";

/**
 * The directory that holds `outcome-log.jsonl`. Honors `PATCHWORK_HOME` (when
 * set) so the WRITE path — `patchwork outcomes confirm|reject`, the
 * outcome-ingester, and `POST /outcomes` — and the READ path — the trust-replay
 * dial + the live gate in `runWorkerShadow` — always resolve to the SAME file.
 * An explicit `override` (a test tmp dir, or the shadow's `opts.patchworkDir`)
 * wins. This is the single source of truth for the log location: resolving it
 * inconsistently on the read vs write side silently breaks the confirm loop on
 * any box that sets `PATCHWORK_HOME` (a dashboard/CLI confirm writes one file
 * while the dial reads another).
 */
export function resolveOutcomeLogDir(override?: string): string {
  return (
    override ?? process.env.PATCHWORK_HOME ?? path.join(homedir(), ".patchwork")
  );
}

export interface OutcomeRecord {
  /** GitHub issue URL — the lookup key. */
  issueUrl: string;
  disposition: OutcomeDisposition;
  /** Epoch ms when this record was written by the ingester. */
  checkedAt: number;
  /** Optional context for auditing. */
  recipeName?: string;
  workerClass?: string;
}

/**
 * Module-wide cache of parsed outcome-log.jsonl content, keyed by absolute
 * log path and gated on (mtimeMs, size). `getWorkerShadowData` and
 * `loadWorkerTrustForRecipe` each construct a fresh `OutcomeStore` per call
 * (gate/poll), and every call previously re-read + re-parsed the whole file
 * from scratch. Sharing the parsed result across instances (keyed by the
 * file's own change signal, not by instance lifetime) means only the FIRST
 * reader after a real write pays the parse cost — every other instance,
 * regardless of when it was constructed, gets the cached maps.
 */
interface OutcomeLogCacheEntry {
  mtimeMs: number;
  size: number;
  dispositions: Map<string, OutcomeDisposition>;
  records: Map<string, OutcomeRecord>;
}
const outcomeLogCache = new Map<string, OutcomeLogCacheEntry>();

function parseOutcomeLog(logPath: string): {
  dispositions: Map<string, OutcomeDisposition>;
  records: Map<string, OutcomeRecord>;
} {
  const dispositions = new Map<string, OutcomeDisposition>();
  const records = new Map<string, OutcomeRecord>();
  if (!existsSync(logPath)) return { dispositions, records };
  const text = readFileSync(logPath, "utf-8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as OutcomeRecord;
      if (r.issueUrl && r.disposition) {
        dispositions.set(r.issueUrl, r.disposition);
        records.set(r.issueUrl, r);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return { dispositions, records };
}

/** Fresh parse + fresh stat, always (used to (re)seed the shared cache). */
function loadOutcomeLogEntry(logPath: string): OutcomeLogCacheEntry {
  let mtimeMs = -1;
  let size = -1;
  try {
    const st = statSync(logPath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    /* file absent — still cacheable at (-1, -1) */
  }
  const { dispositions, records } = parseOutcomeLog(logPath);
  return { mtimeMs, size, dispositions, records };
}

/** The shared entry for `logPath`, reparsing only if the file actually changed. */
function getOutcomeLogEntry(logPath: string): OutcomeLogCacheEntry {
  let statMtimeMs = -1;
  let statSize = -1;
  try {
    const st = statSync(logPath);
    statMtimeMs = st.mtimeMs;
    statSize = st.size;
  } catch {
    /* file absent */
  }
  const cached = outcomeLogCache.get(logPath);
  if (cached && cached.mtimeMs === statMtimeMs && cached.size === statSize) {
    return cached;
  }
  const fresh = loadOutcomeLogEntry(logPath);
  outcomeLogCache.set(logPath, fresh);
  return fresh;
}

/**
 * Persist + query outcome dispositions for filed issues.
 *
 * Storage: append-only JSONL at `~/.patchwork/outcome-log.jsonl` (one record
 * per line). Later writes for the same issueUrl supersede earlier ones — the
 * in-memory cache always resolves to the LAST record for a URL (last-writer-
 * wins). This lets the ingester update a disposition as an issue evolves
 * (e.g. open → closed-as-completed over days).
 *
 * Write path: `upsert()` — called by the outcome-ingester cron recipe.
 * Read path: `getDisposition(url)` — called by WorkerShadowObserver.ingestRun
 *             on the hot trust-replay path. Backed by a module-wide,
 *             mtime/size-gated cache (see `outcomeLogCache` above) — safe to
 *             construct a new `OutcomeStore` per call; only a real write
 *             triggers a reparse.
 */
export class OutcomeStore {
  private readonly logPath: string;

  constructor(patchworkDir: string) {
    this.logPath = path.join(patchworkDir, "outcome-log.jsonl");
  }

  /**
   * Disposition for `issueUrl`, or null when no record exists.
   * Null is treated by trust-replay as "unknown" — WITHHELD (not folded as
   * evidence). A filing with no recorded disposition can neither raise nor
   * lower trust. (#1064)
   */
  getDisposition(issueUrl: string): OutcomeDisposition | null {
    return getOutcomeLogEntry(this.logPath).dispositions.get(issueUrl) ?? null;
  }

  /**
   * Persist a disposition for `issueUrl`. Later calls supersede earlier ones
   * (both on disk via append, and in the shared in-memory cache).
   */
  upsert(record: OutcomeRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(this.logPath, line, "utf-8");
    // Re-seed the shared cache from the post-write file state so this write
    // (and any concurrent writer's) is visible immediately to every
    // OutcomeStore instance pointed at this path — not just this one.
    outcomeLogCache.set(this.logPath, loadOutcomeLogEntry(this.logPath));
  }

  /** All records (deduped, last-writer-wins). For reporting / ingester diffing. */
  readAll(): OutcomeRecord[] {
    return Array.from(getOutcomeLogEntry(this.logPath).records.values());
  }
}

/**
 * Map a GitHub issue's state/labels to an OutcomeDisposition.
 * Pure function — used both by the ingester recipe agent prompt and by tests.
 *
 * Junk signals (any one → junk):
 *   - state_reason: "not_planned"
 *   - labels containing: "invalid", "duplicate", "wontfix", "won't fix",
 *     "not a bug", "by design", "spam"
 *
 * Confirmed signals (issue closed with a positive signal):
 *   - state: "closed" + state_reason: "completed" (GitHub's default close)
 *   - labels containing: "patchwork:valid", "confirmed", "verified"
 *
 * Unknown: still open, or closed with no clear signal.
 */
export function classifyIssueDisposition(issue: {
  state?: string;
  state_reason?: string | null;
  labels?: Array<string | { name?: string }>;
}): OutcomeDisposition {
  const labelNames = (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .map((s) => s.toLowerCase());

  const JUNK_LABELS = [
    "invalid",
    "duplicate",
    "wontfix",
    "won't fix",
    "not a bug",
    "by design",
    "spam",
  ];
  const CONFIRMED_LABELS = ["patchwork:valid", "confirmed", "verified"];

  if (JUNK_LABELS.some((j) => labelNames.some((l) => l.includes(j))))
    return "junk";
  if (issue.state_reason === "not_planned") return "junk";

  if (CONFIRMED_LABELS.some((c) => labelNames.some((l) => l.includes(c))))
    return "confirmed";
  if (issue.state === "closed" && issue.state_reason === "completed")
    return "confirmed";

  return "unknown";
}
