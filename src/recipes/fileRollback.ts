/**
 * Ephemeral rollback for recipe file-write steps.
 *
 * Next item in the trust-architecture roadmap sequencing after the policy
 * layer (#1157/#1158/#1159), cross-run idempotency (PR5b, idempotencyKey.ts)
 * and general-purpose circuit breakers (circuitBreaker.ts).
 *
 * Captures a PRE-IMAGE of a file the FIRST time a `file.write` / `file.append`
 * step in a given `(recipeName, manualRunId)` attempt touches it — same
 * scoping as WriteEffectLedger (PR5b), so both features share the operator's
 * existing `--ledger-dir` / `--attempt` inputs. `rollbackFileWrites` replays
 * those pre-images to undo every file-write side effect from that attempt: a
 * file that existed before is restored to its prior content; a file that did
 * NOT exist before is deleted.
 *
 * "Ephemeral" — like the effect ledger, this is attempt-scoped, not a
 * general version-control system. It answers "undo what THIS run just did
 * to the filesystem", not "show me file history."
 *
 * Deliberately narrow to file.* tools for v1: unlike a file write, undoing a
 * GitHub issue creation, a Slack post, or a git push has no generic inverse
 * — each needs domain-specific "undo" logic (close vs delete vs revert) that
 * the existing `patchwork outcomes reject` disposition doesn't attempt
 * either (it records a trust disposition, not an undo). Out of scope here.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../fileLockSync.js";
import type { Logger } from "../logger.js";
import { writeFileAtomicSync } from "../writeFileAtomic.js";

export interface FileRollbackLogOptions {
  /** Directory holding `file_rollback.jsonl`. Created if missing. */
  dir: string;
  /** `deriveScopeKey(recipeName, manualRunId)` — composed by the caller. */
  scopeKey: string;
  logger?: Logger;
}

interface RollbackRow {
  scopeKey: string;
  path: string;
  hadContent: boolean;
  content: string | null;
  recordedAt: number;
  /**
   * True when the pre-image could NOT be reliably determined — either the
   * path was a pre-existing symlink (content deliberately not read; see
   * `capturePreImage`'s symlink branch) or reading it failed with
   * something other than ENOENT (e.g. EACCES). In both cases `hadContent`
   * is meaningless/unsafe to act on: the file may genuinely have existed
   * with real content that was never captured. `rollbackFileWrites` must
   * NOT treat an uncertain row as "didn't exist, delete it" — that would
   * silently discard the symlink/permission-denied file's real prior
   * content while reporting a misleading "deleted" success. Absent
   * (undefined) on rows from before this field existed — those round-trip
   * as `hadContent: false` for back-compat, same as always.
   */
  uncertain?: boolean;
}

const LOG_FILENAME = "file_rollback.jsonl";
const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB — same posture as WriteEffectLedger
const MAX_PERSIST_LINES = 10_000;

/** See WriteEffectLedger's `assertSafeLedgerDir` — identical rationale. */
function assertSafeDir(dir: string): void {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("dir must be a non-empty string");
  }
  if (dir.includes("\0")) {
    throw new Error("dir must not contain null bytes");
  }
  if (!path.isAbsolute(dir)) {
    throw new Error(`dir must be an absolute path; got: ${dir}`);
  }
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`dir must not be a symlink: ${dir}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // dir will be created later — fine
    throw err;
  }
}

function readRows(
  file: string,
  scopeKey: string,
  logger?: Logger,
): RollbackRow[] {
  let raw: string;
  try {
    // lstat (not stat) — refuse to follow a symlink swapped onto the log
    // path, same guard as WriteEffectLedger.loadExisting.
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      logger?.warn?.(
        `[file-rollback] refusing to read ${file}: file is a symlink`,
      );
      return [];
    }
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger?.warn?.(
        `[file-rollback] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }
  const rows: RollbackRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as RollbackRow;
      if (typeof row.scopeKey !== "string" || typeof row.path !== "string") {
        continue;
      }
      if (row.scopeKey === scopeKey) rows.push(row);
    } catch {
      /* skip malformed row */
    }
  }
  return rows;
}

/**
 * Per-attempt log of file pre-images. Constructed once per recipe run
 * (mirrors WriteEffectLedger's disk mode) and threaded through StepDeps as
 * `fileRollbackLog`; `file.write` / `file.append` call `capturePreImage`
 * before writing.
 */
export class FileRollbackLog {
  private readonly captured = new Set<string>();
  private readonly dir: string;
  private readonly scopeKey: string;
  private readonly file: string;
  private readonly logger?: Logger;

  constructor(opts: FileRollbackLogOptions) {
    assertSafeDir(opts.dir);
    this.dir = opts.dir;
    this.scopeKey = opts.scopeKey;
    this.file = path.join(opts.dir, LOG_FILENAME);
    this.logger = opts.logger;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.logger?.warn?.(
        `[file-rollback] could not create ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Resuming an attempt (retry of the same manualRunId) must not
    // re-capture a path already snapshotted — the pre-image on disk is the
    // true "before this attempt began" state; a mid-retry re-capture would
    // silently narrow what rollback can undo.
    for (const row of readRows(this.file, this.scopeKey, this.logger)) {
      this.captured.add(row.path);
    }
  }

  /**
   * Snapshot `absPath`'s current content before a write. No-op if this path
   * was already captured earlier in the same scope. Best-effort: a snapshot
   * failure is logged but never blocks the write it's guarding — losing
   * rollback capability for one path is preferable to failing the run.
   */
  capturePreImage(absPath: string): void {
    if (this.captured.has(absPath)) return;
    this.captured.add(absPath);
    let hadContent = false;
    let content: string | null = null;
    let uncertain = false;
    try {
      const st = lstatSync(absPath);
      if (st.isSymbolicLink()) {
        // Refuse to READ through a symlink (avoid trusting an
        // attacker-controlled symlink target's content as the pre-image),
        // but the subsequent file.write/file.append DOES write through it
        // — mutating whatever the symlink points at. So this is NOT safe
        // to record as "didn't exist": mark it `uncertain` so rollback
        // reports a failure instead of deleting the symlink and claiming
        // a false "restored to prior state" while the real target's
        // original content is permanently unrecoverable.
        uncertain = true;
        this.logger?.warn?.(
          `[file-rollback] ${absPath} is a symlink — pre-image not captured, rollback for this path will fail loudly instead of guessing`,
        );
      } else {
        // Read as bytes first and verify a LOSSLESS utf-8 round-trip
        // before trusting a string capture. A binary file (image,
        // archive, etc.) decoded via readFileSync(path, "utf-8") silently
        // replaces invalid byte sequences with U+FFFD — capturing that
        // and writing it back on rollback would permanently corrupt the
        // file instead of restoring it. JSONL (this log's own format)
        // can only carry text anyway, so a genuinely binary pre-image
        // has no lossless representation here — mark uncertain rather
        // than pretend to capture it.
        const buf = readFileSync(absPath);
        const decoded = buf.toString("utf-8");
        if (Buffer.from(decoded, "utf-8").equals(buf)) {
          content = decoded;
          hadContent = true;
        } else {
          uncertain = true;
          this.logger?.warn?.(
            `[file-rollback] ${absPath} is not losslessly representable as utf-8 (binary content) — pre-image not captured, rollback for this path will fail loudly instead of corrupting it`,
          );
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Genuinely did not exist — hadContent: false is correct and safe;
        // rollback deleting it later is the right undo.
      } else {
        // Some other failure (EACCES, EPERM, ...) — the file may well
        // exist with real content we simply couldn't read. Do NOT
        // conflate this with ENOENT's "didn't exist": mark uncertain so
        // rollback fails loudly instead of silently unlinking a file that
        // existed all along.
        uncertain = true;
        this.logger?.warn?.(
          `[file-rollback] could not snapshot ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.append({
      scopeKey: this.scopeKey,
      path: absPath,
      hadContent,
      content,
      recordedAt: Date.now(),
      ...(uncertain && { uncertain }),
    });
  }

  private append(row: RollbackRow): void {
    try {
      // Cross-process lock (ADR-0007-style torn-row guard, same primitive
      // runLog.ts/workerGateDecisionLog.ts use) around the WHOLE check+
      // rotate+append sequence. Without it, rotate()'s read-modify-write
      // (readFileSync -> filter/slice -> writeFileAtomicSync) races a
      // concurrent writer's append landing between the read and the
      // atomic replace: that writer's row is silently overwritten by the
      // rotated content and permanently lost, with no error anywhere.
      withFileLockSync(this.file, () => {
        try {
          const st = statSync(this.file);
          if (st.size > MAX_PERSIST_BYTES) this.rotateLocked();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw err;
        }
        try {
          appendFileSync(this.file, `${JSON.stringify(row)}\n`, {
            mode: 0o600,
          });
        } catch (appendErr) {
          const code = (appendErr as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw appendErr;
          appendFileSync(this.file, `${JSON.stringify(row)}\n`, {
            mode: 0o600,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(
        `[file-rollback] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Trim the log to the most recent MAX_PERSIST_LINES lines. Trims across
   * ALL scopes in the file (same tradeoff WriteEffectLedger accepts) — a
   * long-lived ledger dir shared by many attempts rotates as one file.
   * MUST be called from inside `append`'s `withFileLockSync` — the
   * read-modify-write here is only race-safe under that lock.
   */
  private rotateLocked(): void {
    try {
      const raw = readFileSync(this.file, "utf-8");
      let lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      writeFileAtomicSync(
        this.file,
        lines.length > 0 ? `${lines.join("\n")}\n` : "",
        {
          mode: 0o600,
        },
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      this.logger?.warn?.(
        `[file-rollback] rotate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Pre-images captured for this scope, in capture order. */
  rows(): Array<{
    path: string;
    hadContent: boolean;
    content: string | null;
    uncertain?: boolean;
  }> {
    return readRows(this.file, this.scopeKey, this.logger).map((r) => ({
      path: r.path,
      hadContent: r.hadContent,
      content: r.content,
      ...(r.uncertain && { uncertain: r.uncertain }),
    }));
  }
}

export interface RollbackResult {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Replay a `FileRollbackLog`'s captured pre-images, restoring every file the
 * attempt touched to its state before the attempt began. Best-effort
 * per-file — one failure doesn't abort the rest, so a partial rollback still
 * undoes everything it can.
 */
export function rollbackFileWrites(
  opts: FileRollbackLogOptions,
): RollbackResult {
  const log = new FileRollbackLog(opts);
  const result: RollbackResult = { restored: [], deleted: [], failed: [] };
  for (const row of log.rows()) {
    if (row.uncertain) {
      // Pre-image genuinely unknown (pre-existing symlink or an
      // unreadable-for-another-reason file) — guessing "delete it" could
      // destroy real content that was never captured. Fail loudly instead.
      result.failed.push({
        path: row.path,
        error:
          "pre-image not captured (was a symlink, or unreadable for a " +
          "reason other than not existing) — refusing to guess whether " +
          "to restore or delete; check the path manually",
      });
      continue;
    }
    try {
      if (row.hadContent && row.content !== null) {
        mkdirSync(path.dirname(row.path), { recursive: true });
        writeFileAtomicSync(row.path, row.content);
        result.restored.push(row.path);
      } else {
        if (existsSync(row.path)) unlinkSync(row.path);
        result.deleted.push(row.path);
      }
    } catch (err) {
      result.failed.push({
        path: row.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
