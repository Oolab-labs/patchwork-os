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
    return;
  }

  // POSIX: try process-group kill first (works when child was spawned
  // detached:true → setsid → process-group leader). ESRCH for non-detached
  // children is expected and swallowed; child.kill() below handles the
  // single-child case so the immediate child always gets signaled.
  try {
    process.kill(-pid, signal);
  } catch {
    /* not a group leader */
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}
