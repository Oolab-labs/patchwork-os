import fs from "node:fs";

/**
 * Watch a directory for any change, falling back to mtime polling when
 * `fs.watch` is unavailable or fails.
 *
 * Motivation: `fs.watch` is unreliable on several real-world filesystems —
 * Windows network drives (SMB/CIFS), WSL bind mounts, and macOS volumes
 * mounted from a Linux host all either throw at watch time or stop firing
 * events silently mid-session. The bridge's plugin hot-reload and kill-
 * switch flag watcher silently went dead on those mounts.
 *
 * Behaviour:
 *   - First try `fs.watch(dir, { recursive: false })`. If it succeeds, also
 *     listen for the watcher's `error` event so a mid-session breakdown
 *     swaps to polling without losing change notifications.
 *   - If `fs.watch` throws (e.g. ENOENT — the directory doesn't exist yet,
 *     or EPERM — the filesystem doesn't support watching), start polling
 *     immediately.
 *   - Polling: stat the directory every `pollIntervalMs` (default 2000ms)
 *     and stat each non-dot file in it. Fire `onChange` if any file's
 *     mtime advanced, a file appeared, or a file disappeared. If the
 *     directory itself is missing, keep polling — it may appear later.
 *
 * Caller filters changes by re-reading the file(s) of interest. The helper
 * deliberately does NOT expose the changed filename: polling can't reliably
 * provide that, and fs.watch filenames are already null on some platforms
 * (Windows rename events, atomic saves). One source of truth keeps callers
 * platform-agnostic.
 *
 * Returns a `stop()` function that releases both the watcher and the timer.
 */
export function watchDirectoryWithFallback(
  dir: string,
  onChange: () => void,
  opts: {
    pollIntervalMs?: number;
    logger?: { warn: (msg: string) => void } | undefined;
  } = {},
): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const logger = opts.logger;

  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // Snapshot: filename → mtimeMs. Empty Map when directory doesn't exist.
  let snapshot = new Map<string, number>();

  const snapshotDir = (): Map<string, number> => {
    const out = new Map<string, number>();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (ent.name.startsWith(".")) continue;
        try {
          const st = fs.statSync(`${dir}/${ent.name}`);
          out.set(ent.name, st.mtimeMs);
        } catch {
          /* file disappeared between readdir and stat — ignore */
        }
      }
    } catch {
      /* dir missing — empty snapshot */
    }
    return out;
  };

  const startPolling = (reason: string): void => {
    if (pollTimer || stopped) return;
    if (logger) logger.warn(`[fs-watch] falling back to polling: ${reason}`);
    snapshot = snapshotDir();
    pollTimer = setInterval(() => {
      if (stopped) return;
      const next = snapshotDir();
      let changed = next.size !== snapshot.size;
      if (!changed) {
        for (const [name, mtime] of next) {
          const prev = snapshot.get(name);
          if (prev === undefined || prev !== mtime) {
            changed = true;
            break;
          }
        }
      }
      snapshot = next;
      if (changed) onChange();
    }, pollIntervalMs);
    // Don't keep the event loop alive solely for polling.
    pollTimer.unref?.();
  };

  try {
    watcher = fs.watch(dir, { recursive: false }, () => {
      if (!stopped) onChange();
    });
    watcher.on("error", (err) => {
      // Watcher broke mid-session. Tear it down, start polling.
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      watcher = null;
      startPolling(`watcher error: ${err.message}`);
    });
  } catch (err) {
    startPolling(
      `fs.watch threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return (): void => {
    stopped = true;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
