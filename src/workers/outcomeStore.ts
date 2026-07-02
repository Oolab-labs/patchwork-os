import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
 *             on the hot trust-replay path. Cache is lazy-loaded once per
 *             instance; create a new instance per trust-replay (the observer
 *             already does one replay per gate decision).
 */
export class OutcomeStore {
  private readonly logPath: string;
  /** Lazy-loaded from disk. null = not yet loaded. */
  private _cache: Map<string, OutcomeDisposition> | null = null;

  constructor(patchworkDir: string) {
    this.logPath = path.join(patchworkDir, "outcome-log.jsonl");
  }

  /** Last-writer-wins map of issueUrl → disposition. Loaded once per instance. */
  private get cache(): Map<string, OutcomeDisposition> {
    if (this._cache) return this._cache;
    this._cache = new Map();
    if (!existsSync(this.logPath)) return this._cache;
    const text = readFileSync(this.logPath, "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t) as OutcomeRecord;
        if (r.issueUrl && r.disposition) {
          this._cache.set(r.issueUrl, r.disposition);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return this._cache;
  }

  /**
   * Disposition for `issueUrl`, or null when no record exists.
   * Null is treated by trust-replay as "unknown" — WITHHELD (not folded as
   * evidence). A filing with no recorded disposition can neither raise nor
   * lower trust. (#1064)
   */
  getDisposition(issueUrl: string): OutcomeDisposition | null {
    return this.cache.get(issueUrl) ?? null;
  }

  /**
   * Persist a disposition for `issueUrl`. Later calls supersede earlier ones
   * (both on disk via append, and in the in-memory cache).
   */
  upsert(record: OutcomeRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(this.logPath, line, "utf-8");
    // Update cache so the same instance sees its own write immediately.
    if (this._cache) this._cache.set(record.issueUrl, record.disposition);
  }

  /** All records (deduped, last-writer-wins). For reporting / ingester diffing. */
  readAll(): OutcomeRecord[] {
    // Re-parse to get full records (cache only stores disposition).
    const seen = new Map<string, OutcomeRecord>();
    if (!existsSync(this.logPath)) return [];
    const text = readFileSync(this.logPath, "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t) as OutcomeRecord;
        if (r.issueUrl && r.disposition) seen.set(r.issueUrl, r);
      } catch {
        /* skip malformed */
      }
    }
    return Array.from(seen.values());
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
