/** Maximum time to wait for a file lock before aborting the operation. */
export const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;

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
   */
  async acquire(path: string): Promise<() => void> {
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
        // If we timed out waiting, remove our tail promise so the queue doesn't
        // grow unboundedly with waiter promises that will never run.
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

    // Clean up map entry after release so it doesn't grow forever
    const wrappedRelease = () => {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
    };
    return wrappedRelease;
  }
}
