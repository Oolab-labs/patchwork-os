import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";

/**
 * Kill a child process and all its descendants.
 *
 * Node's `child.kill()` and the AbortSignal-driven kill that `spawn({ signal })`
 * wires up both only signal the immediate child. That leaves grandchildren
 * orphaned when a Claude task is cancelled or times out.
 *
 * On POSIX, a process spawned with `detached: true` is its own process-group
 * leader (`setsid()`); signalling the negative PID kills the whole group.
 *
 * On Windows there's no process-group concept, so the canonical way to kill
 * a tree is `taskkill /F /T /PID <pid>` — `/F` force, `/T` includes children.
 *
 * Best-effort: a process that already exited (or that we lack permission to
 * signal) is not an error. Callers may invoke this from abort handlers that
 * fire after the child has already closed.
 */
export function treeKill(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  // != null covers both `null` (live) and `undefined` (test mocks that omit
  // the field). A real ChildProcess has these as `number|null` / `Signals|null`.
  if (child.exitCode != null || child.signalCode != null) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Best-effort. Common reasons: child already exited, permission denied,
      // taskkill not on PATH (locked-down Windows installs).
    }
  } else {
    // POSIX: process-group kill (works when child was spawned detached:true →
    // setsid → process-group leader). ESRCH for non-detached children is
    // expected; child.kill() below handles the single-child case.
    try {
      process.kill(-pid, signal);
    } catch {
      /* not a group leader */
    }
  }

  // Single-child backstop on every platform. On Windows, taskkill /T should
  // have killed the immediate child already, making this a no-op; but it
  // ensures the ChildProcess fires its `close` event in test stubs that
  // override `child.kill` and short-circuits the spawn/auto-kill flow.
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

/**
 * Kill a process tree by bare pid. Same semantics as `treeKill` but for
 * callers that only hold a numeric pid (e.g. a child the bridge spawned
 * with `detached: true; unref()` and let go of the ChildProcess handle).
 *
 * On Windows this is the only correct way to reap grandchildren — bare
 * `process.kill(pid, sig)` maps to `TerminateProcess` which skips them.
 * On POSIX it best-effort signals the process group (`-pid`) when the
 * target is a group leader, then falls back to single-pid signal.
 *
 * Audit 2026-05-17: spawnWorkspace.ts and the `--watch` supervisor in
 * src/index.ts both held a foreign-pid handle (no ChildProcess) and
 * fell back to `process.kill(pid, sig)`. Use this helper instead.
 */
export function treeKillPid(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Already exited / permission denied / taskkill missing — best-effort.
    }
    return;
  }
  // POSIX: try process-group kill first (works when target was spawned
  // detached → setsid → group leader). Fall back to single-pid signal.
  try {
    process.kill(-pid, signal);
  } catch {
    /* not a group leader */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited */
  }
}
