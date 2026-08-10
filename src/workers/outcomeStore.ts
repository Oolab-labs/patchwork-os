import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type ActionRef,
  AmbiguousActionRefError,
  canonicalActionRef,
} from "./actionRef.js";

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
  /**
   * GitHub issue URL — the legacy lookup key, and still the key for any row
   * that has one. Optional ONLY because `ref` is the alternative; exactly one
   * of `issueUrl` / `ref` must be present or the row cannot be keyed at all
   * (see `parseOutcomeLog`, which now REPORTS such rows rather than dropping
   * them silently).
   */
  issueUrl?: string;
  /**
   * Tool-scoped reference for an action that has no URL — the generalisation
   * that lets a worker earn trust from actions that are not GitHub issues.
   * Keyed via `canonicalActionRef` to `"<tool>:<id>"`, a namespace that cannot
   * collide with `issueUrl` (asserted, not assumed — see actionRef.ts).
   *
   * Existing rows are NOT migrated: a URL is already a fine key, and rewriting
   * the file the autonomy gate rests on to gain uniformity is a bad trade.
   */
  ref?: ActionRef;
  disposition: OutcomeDisposition;
  /** Epoch ms when this record was written by the ingester. */
  checkedAt: number;
  /** Optional context for auditing. */
  recipeName?: string;
  workerClass?: string;
  /**
   * Who wrote this record. "manual" — an operator ran `patchwork outcomes
   * confirm|reject`, an explicit human judgment call. "ingester" — the
   * automated outcome-ingester cron classifying GitHub issue state/labels.
   * Missing on records written before this field existed; treated as
   * "ingester" (conservative — old records get no special protection).
   *
   * Precedence: a "manual" disposition is STICKY against later "ingester"
   * writes for the same issueUrl — see resolveDispositions() below. Without
   * this, an operator's deliberate "this filing was junk" verdict (e.g. to
   * confirm the trust dial correctly stays flat on a known-synthetic test
   * issue) could be silently overwritten by the next automated poll, which
   * has no way to know the human already made a final call. A later manual
   * write always wins (the operator can change their own mind); only
   * ingester-over-manual is blocked.
   */
  origin?: "manual" | "ingester";
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
  /** Rows that could not be keyed or parsed — see `UnkeyableRow`. */
  unkeyable: UnkeyableRow[];
}
const outcomeLogCache = new Map<string, OutcomeLogCacheEntry>();

/**
 * A row the parser could not turn into a lookup key.
 *
 * These used to be `continue`d silently. That is the quiet-corruption vector
 * this file most needs to avoid: the outcome log is the ONLY record of which
 * worker actions a human actually blessed, so a row that vanishes on read
 * looks exactly like a row nobody ever wrote — and the difference is whether
 * a worker earned its autonomy. They are still skipped (a row with no key is
 * genuinely unusable), but they are now COUNTED and reportable.
 */
export interface UnkeyableRow {
  /** 1-based line number in the log, so an operator can go find it. */
  line: number;
  reason: "malformed-json" | "no-key" | "no-disposition" | "bad-ref";
  /** First 120 chars of the offending line, for identification. */
  excerpt: string;
}

/**
 * The lookup key for a record: its `ref` (canonicalised) when present,
 * otherwise its legacy `issueUrl`. Returns null when neither yields one.
 */
function keyForRecord(r: OutcomeRecord): string | null {
  if (r.ref) {
    try {
      return canonicalActionRef(r.ref);
    } catch {
      return null;
    }
  }
  return r.issueUrl?.trim() || null;
}

function parseOutcomeLog(logPath: string): {
  dispositions: Map<string, OutcomeDisposition>;
  records: Map<string, OutcomeRecord>;
  unkeyable: UnkeyableRow[];
} {
  const dispositions = new Map<string, OutcomeDisposition>();
  const records = new Map<string, OutcomeRecord>();
  const unkeyable: UnkeyableRow[] = [];
  if (!existsSync(logPath)) return { dispositions, records, unkeyable };
  const text = readFileSync(logPath, "utf-8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    if (!t) continue;
    const excerpt = t.slice(0, 120);
    let r: OutcomeRecord;
    try {
      r = JSON.parse(t) as OutcomeRecord;
    } catch {
      unkeyable.push({ line: i + 1, reason: "malformed-json", excerpt });
      continue;
    }
    if (!r.disposition) {
      unkeyable.push({ line: i + 1, reason: "no-disposition", excerpt });
      continue;
    }
    const key = keyForRecord(r);
    if (!key) {
      unkeyable.push({
        line: i + 1,
        reason: r.ref ? "bad-ref" : "no-key",
        excerpt,
      });
      continue;
    }
    // A manual disposition is sticky against a later ingester write for
    // the same key — an automated poll must not silently erase an
    // operator's explicit judgment call. A later manual write (the
    // operator changing their own mind) always applies normally.
    const existing = records.get(key);
    if (existing?.origin === "manual" && r.origin !== "manual") continue;
    dispositions.set(key, r.disposition);
    records.set(key, r);
  }
  return { dispositions, records, unkeyable };
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
  const { dispositions, records, unkeyable } = parseOutcomeLog(logPath);
  return { mtimeMs, size, dispositions, records, unkeyable };
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
  getDisposition(key: string): OutcomeDisposition | null {
    return getOutcomeLogEntry(this.logPath).dispositions.get(key) ?? null;
  }

  /**
   * Disposition for a tool-scoped action reference (the non-URL join). Same
   * null semantics as `getDisposition`. A ref that cannot be canonicalised
   * returns null rather than throwing — this is a read path, and the fold
   * must never crash on a malformed stored ref.
   */
  getDispositionForRef(ref: ActionRef): OutcomeDisposition | null {
    let key: string;
    try {
      key = canonicalActionRef(ref);
    } catch {
      return null;
    }
    return this.getDisposition(key);
  }

  /**
   * Rows in the log that carry no usable lookup key (or no disposition, or
   * are not valid JSON). Empty in the healthy case. Surfaced so an operator
   * can be TOLD the ledger has holes instead of a confirmation quietly going
   * missing — the whole point of counting these rather than skipping them.
   */
  unkeyableRows(): UnkeyableRow[] {
    return getOutcomeLogEntry(this.logPath).unkeyable;
  }

  /**
   * Persist a disposition. Later calls supersede earlier ones for the same
   * key (both on disk via append, and in the shared in-memory cache).
   *
   * Throws when the record carries neither a usable `ref` nor an `issueUrl`:
   * a row written with no key is invisible to every reader, so accepting it
   * would silently discard an operator's explicit judgment.
   */
  upsert(record: OutcomeRecord): void {
    // Canonicalise a `ref` directly rather than via `keyForRecord`, which
    // swallows the reason and returns null. The WRITE path must report WHY —
    // "your tool name is URL-shaped" and "you sent no key at all" send an
    // operator to completely different places, and a misdiagnosis here costs
    // them a hunt through the wrong file.
    if (record.ref) {
      canonicalActionRef(record.ref); // throws AmbiguousActionRefError, with cause
    } else if (!keyForRecord(record)) {
      throw new AmbiguousActionRefError(
        "An outcome record needs a usable key — either `issueUrl` or a `ref` with a tool and an id. Refusing to write a record nothing can look up.",
      );
    }
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
