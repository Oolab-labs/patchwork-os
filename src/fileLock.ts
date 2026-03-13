/** Maximum time to wait for a file lock before aborting the operation. */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * Promise-chain mutex keyed by absolute file path.
 * Serializes concurrent file edits across multiple agent sessions.
 */
export class FileLock {
  private locks = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Acquire exclusive access to a file path.
   * Returns a release function — call it in a finally block.
   * Throws if the lock is not acquired within timeoutMs (default: 15s).
   *
   * @param signal - Optional AbortSignal. If the signal fires while the lock is
   *   held, the lock is released automatically so downstream waiters are not
   *   blocked for the full timeout period. Callers should still use try/finally
   *   to guarantee release() is called in the normal path.
   */
  async acquire(path: string, signal?: AbortSignal): Promise<() => void> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    // Register our promise as the new tail before awaiting the previous holder,
    // so any subsequent caller chains behind us.
    this.locks.set(path, next);

    // Race the previous holder against a timeout to prevent indefinite hangs
    // if a holder crashes or its tool call is cancelled without releasing.
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve(); // resolve (not reject) so the Promise itself is never "unhandled"
      }, this.timeoutMs);
    });
    try {
      await Promise.race([prev, timeout]);
      clearTimeout(timeoutId);
      if (timedOut) {
        // Resolve next before throwing so any waiter chained behind us is not
        // blocked for another full timeout cycle — they get the lock immediately
        // (even though we do no work) and proceed normally.
        release();
        if (this.locks.get(path) === next) this.locks.delete(path);
        throw new Error(
          `Timed out waiting for file lock on "${path}" after ${this.timeoutMs / 1000}s — another session may be editing the same file`,
        );
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (this.locks.get(path) === next) this.locks.delete(path);
      throw err;
    }

    // Bail out immediately if already aborted before acquiring
    if (signal?.aborted) {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
      throw new Error("Aborted before lock acquired");
    }

    // Clean up map entry after release so it doesn't grow forever
    const wrappedRelease = () => {
      signal?.removeEventListener("abort", onAbort);
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
    };

    // If the holder is aborted while holding the lock, release automatically
    // so downstream waiters are not blocked for the full timeout period.
    const onAbort = () => wrappedRelease();
    signal?.addEventListener("abort", onAbort, { once: true });

    return wrappedRelease;
  }
}
