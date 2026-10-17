import { constants } from "node:os";

/**
 * The exit code to report for a child process's `close` event.
 *
 * Node gives `code === null` and a signal name when the child was killed by
 * a signal. Reporting that as 0 turned an out-of-memory kill or an external
 * SIGKILL into a successful run (audit M25). A signal kill is reported as
 * `128 + signal number`, the shell's convention (SIGKILL → 137); a null code
 * with no signal, which Node does not document but must not read as success,
 * is reported as 1.
 */
export function exitCodeOf(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal) {
    const n = (constants.signals as Record<string, number | undefined>)[signal];
    return 128 + (n ?? 0);
  }
  return 1;
}
