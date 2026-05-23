import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Atomic file-write helpers — write to a sibling temp file, then `rename`
 * into the target path. A crash mid-write leaves only the orphan temp
 * file; the target is either the old content or the new content, never
 * truncated.
 *
 * Why a shared helper?
 * The recipe-runner / approval / token-storage paths already use this
 * shape ad-hoc (see runLog.ts, decisionTraceLog.ts, activationMetrics.ts,
 * connectors/tokenStorage.ts). The user-source-file edit tools
 * (`editText`, `replaceBlock`, `searchAndReplace`, `transaction`,
 * `refactorExtractFunction`, `fileOperations` overwrite) were doing
 * direct `writeFile`/`writeFileSync` — a crash mid-write corrupts the
 * user's code. Audit 2026-05-17.
 *
 * Temp-name shape: `${target}.tmp.${pid}.${rand}` — pid + 12 random hex
 * chars so concurrent writes to the same target don't collide on their
 * temp files (the rename is single-threaded at the kernel level; the
 * collision risk is the temp file, not the final state).
 *
 * Cleanup on failure: if `writeFile` succeeds but `rename` fails, we
 * best-effort `unlink` the temp file before re-throwing. If `writeFile`
 * itself fails the temp file may not exist; we ignore unlink errors in
 * both cases.
 *
 * NOT a `fsync` guarantee: Node's `writeFile`/`writeFileSync` does not
 * fsync the file before close, and `rename`/`renameSync` does not fsync
 * the parent dir. On `ext4` data=ordered and `apfs` this is fine in
 * practice — the rename can't make the new contents visible until the
 * data write hits the journal. On power-loss this guarantee weakens;
 * accept that as a separate hardening pass.
 */

function tempPathFor(target: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${target}.tmp.${process.pid}.${rand}`;
}

export type WriteFileAtomicData = string | NodeJS.ArrayBufferView;

export interface WriteFileAtomicOptions {
  /** Mode for the final file. Default: 0o644. */
  mode?: number;
  /** Encoding when `data` is a string. Default: utf-8. */
  encoding?: BufferEncoding;
  /**
   * Optional cancellation signal — async variant only. Aborts the
   * underlying `fs.promises.writeFile`; if abort fires after the
   * write completes but before the rename, the target is left
   * unchanged and the temp file is cleaned up.
   */
  signal?: AbortSignal;
}

/**
 * Synchronous atomic write. Throws on failure. Best-effort temp cleanup.
 */
export function writeFileAtomicSync(
  target: string,
  data: WriteFileAtomicData,
  opts: WriteFileAtomicOptions = {},
): void {
  const tmp = tempPathFor(target);
  const mode = opts.mode ?? 0o644;
  try {
    if (typeof data === "string") {
      fs.writeFileSync(tmp, data, { mode, encoding: opts.encoding ?? "utf-8" });
    } else {
      fs.writeFileSync(tmp, data, { mode });
    }
    try {
      fs.renameSync(tmp, target);
    } catch (renameErr) {
      // On Windows, renameSync throws EEXIST when the target already exists
      // (unlike POSIX which atomically replaces). Unlink the target and retry.
      if (
        process.platform === "win32" &&
        (renameErr as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        fs.unlinkSync(target);
        fs.renameSync(tmp, target);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone or never created
    }
    throw err;
  }
}

/**
 * Async atomic write. Returns a Promise; rejects on failure. Best-effort
 * temp cleanup. Uses `fs.promises` end-to-end.
 */
export async function writeFileAtomic(
  target: string,
  data: WriteFileAtomicData,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const tmp = tempPathFor(target);
  const mode = opts.mode ?? 0o644;
  try {
    if (typeof data === "string") {
      await fs.promises.writeFile(tmp, data, {
        mode,
        encoding: opts.encoding ?? "utf-8",
        signal: opts.signal,
      });
    } else {
      await fs.promises.writeFile(tmp, data, { mode, signal: opts.signal });
    }
    try {
      await fs.promises.rename(tmp, target);
    } catch (renameErr) {
      // Windows: rename throws EEXIST when target exists (unlike POSIX atomic replace).
      if (
        process.platform === "win32" &&
        (renameErr as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        await fs.promises.unlink(target);
        await fs.promises.rename(tmp, target);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // already gone or never created
    }
    throw err;
  }
}
