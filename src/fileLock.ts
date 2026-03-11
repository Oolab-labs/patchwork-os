/**
 * Promise-chain mutex keyed by absolute file path.
 * Serializes concurrent file edits across multiple agent sessions.
 */
export class FileLock {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire exclusive access to a file path.
   * Returns a release function — call it in a finally block.
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
    await prev;
    // Clean up map entry after release so it doesn't grow forever
    const wrappedRelease = () => {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
    };
    return wrappedRelease;
  }
}
