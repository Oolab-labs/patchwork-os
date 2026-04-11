/** Maximum time to wait for a file lock before aborting the operation. */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;

/** Returned by tryAcquire when the file is already locked by another session. */
export interface LockContention {
  lockedBySession: string;
}

/**
 * Promise-chain mutex keyed by absolute file path.
 * Serializes concurrent file edits across multiple agent sessions.
 */
export class FileLock {
  private locks = new Map<string, Promise<void>>();
  /** Session ID holding each lock (for tryAcquire contention reporting). */
  private holders = new Map<string, string>();
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
  /**
   * Non-blocking variant of acquire. Returns immediately:
   * - `{ release }` if the lock was granted (call release() in a finally block)
   * - `{ lockedBySession }` if the file is currently locked by another session
   *
   * Falls back to regular acquire() when no other session holds the lock.
   */
  tryAcquire(
    path: string,
    sessionId: string,
  ): { release: () => void } | LockContention {
    // Use the `locks` map as the primary contention signal — it is set by
    // BOTH `acquire` and `tryAcquire`, so a lock held via the blocking path
    // is visible here. `holders` is a secondary map that records *who* holds
    // the lock (only set by `tryAcquire`).
    if (this.locks.get(path) !== undefined) {
      const holder = this.holders.get(path) ?? "unknown-session";
      if (holder !== sessionId) {
        return { lockedBySession: holder };
      }
      // Same session already holds the lock — grant re-entry. The new promise
      // chains behind the existing one; the caller gets its own release handle.
    }
    // Lock is free (or same-session re-entry) — grant it synchronously.
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(path, next);
    this.holders.set(path, sessionId);
    const wrappedRelease = () => {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
      if (this.holders.get(path) === sessionId) this.holders.delete(path);
    };
    return { release: wrappedRelease };
  }

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
      this.holders.delete(path);
    };

    // If the holder is aborted while holding the lock, release automatically
    // so downstream waiters are not blocked for the full timeout period.
    const onAbort = () => wrappedRelease();
    signal?.addEventListener("abort", onAbort, { once: true });

    return wrappedRelease;
  }
}
