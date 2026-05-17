import { closeSync, openSync, statSync, unlinkSync } from "node:fs";

/**
 * Tiny cross-process file mutex for synchronous critical sections.
 *
 * Used to wrap append-only JSONL writers (`decisionTraceLog`,
 * `runLog`, `commitIssueLinkLog`) so two bridge processes sharing
 * one `~/.claude/ide/` log directory can't interleave bytes within a
 * single row.
 *
 * Why ad-hoc instead of `proper-lockfile`? proper-lockfile is the more
 * featureful option (TTL refresh, retry jitter, async API) but adds a
 * runtime dependency for a use case the bridge needs only synchronously
 * in three call-sites. The pattern below — `openSync(file, "wx")` as
 * the atomic lock primitive plus a stale-lock cleanup heuristic — is
 * standard for shell-style flock without a native binding.
 *
 * ## Semantics
 *
 * `withFileLockSync(file, fn)`:
 *
 *   1. Attempts to create `${file}.lock` with `O_EXCL` (`flag: "wx"`).
 *      First writer wins atomically — the kernel rejects EEXIST for
 *      every other contender.
 *   2. On EEXIST, polls with a short busy-wait (`Atomics.wait` would
 *      need a shared SharedArrayBuffer across processes — out of scope;
 *      hot-loop with `process.hrtime` instead, kernels schedule sleep
 *      anyway under contention).
 *   3. If the existing lock is older than `staleLockMs` (default 30s),
 *      assumes the owner crashed and force-unlinks it before retrying.
 *      The append-only JSONL writes the bridge does complete in <1ms in
 *      practice, so 30s is generous.
 *   4. Runs `fn()`, unlinks the lock in `finally`. Rethrows fn's
 *      exception.
 *
 * Lock granularity is per-file (each log gets its own lock). At the
 * bridge's write volume (≤ tens/min across all three logs) contention
 * is effectively zero.
 *
 * ## Failure modes
 *
 * - **Deadlock-on-crash:** mitigated by the 30s stale-lock TTL. A bridge
 *   that crashes mid-append leaves the lock until the next contender
 *   notices it's stale and clears it. The first crash is invisible
 *   (target file already written); subsequent contenders pay a 30s
 *   penalty only if they happen to arrive within the window.
 * - **TOCTOU on stale-lock unlink:** two processes both decide the lock
 *   is stale and both `unlinkSync`. Second `unlinkSync` ENOENT is
 *   swallowed. Both then race the `openSync("wx")` — one wins, the
 *   other goes back to polling. No data corruption.
 * - **NFS / non-POSIX FS:** O_EXCL is undefined on stale NFSv2; modern
 *   NFS (≥ v3 with `noac`) and all local FS we ship on (apfs / ext4 /
 *   ntfs) implement it correctly.
 *
 * @param file - The target file the caller is about to write. The lock
 *   sentinel is `${file}.lock`.
 * @param fn - Synchronous critical section. Holds the lock for its
 *   entire duration.
 * @param opts.timeoutMs - Max wait for the lock before throwing (default
 *   5000). Use a small value — appends finish in <1ms in practice; a
 *   timeout this far above the expected duration only fires if
 *   something genuinely wrong happens.
 * @param opts.staleLockMs - Age (ms) at which an existing lock is
 *   considered abandoned and force-unlinked. Default 30000.
 */
export function withFileLockSync<T>(
  file: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleLockMs?: number } = {},
): T {
  const lockFile = `${file}.lock`;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleLockMs = opts.staleLockMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  let lockFd: number | null = null;
  while (lockFd === null) {
    try {
      // O_EXCL — atomic create; first caller wins.
      lockFd = openSync(lockFile, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Stale-lock cleanup. Best-effort: another contender may unlink
      // ours simultaneously; that race resolves benignly (next openSync
      // either wins or sees EEXIST again).
      try {
        const stat = statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          try {
            unlinkSync(lockFile);
          } catch {
            /* already gone — another contender beat us to the cleanup */
          }
          continue;
        }
      } catch {
        // statSync ENOENT — lock cleared between EEXIST and stat; retry
        // immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `withFileLockSync: timed out after ${timeoutMs}ms waiting for ${lockFile}`,
        );
      }
      // Busy-spin for ~5ms via hrtime. Node has no sync sleep; under
      // contention the kernel preempts us, so this isn't actually a hot
      // loop in practice (and tests can pass a 0ms timeout for the
      // "already locked" case).
      const spinUntil = process.hrtime.bigint() + 5_000_000n; // 5ms
      while (process.hrtime.bigint() < spinUntil) {
        /* yield */
      }
    }
  }

  try {
    closeSync(lockFd);
    return fn();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      /* lock cleared by stale-lock cleanup in another process; ok */
    }
  }
}
