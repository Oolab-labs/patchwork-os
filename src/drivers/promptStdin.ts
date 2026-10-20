import type { ChildProcess } from "node:child_process";

/**
 * Hand a CLI child its prompt on STDIN rather than in argv (Private/52 LOW).
 *
 * argv is readable by every local process (`ps`) for the life of the run, and
 * a prompt carries whatever the recipe fed in — mail, tickets, file contents.
 * Each CLI reads its prompt from stdin when none is given as an argument.
 *
 * The write is fire-and-forget and its error is swallowed on purpose: a child
 * that exits before reading (bad flag, missing auth) closes the pipe, and an
 * unhandled EPIPE would crash the bridge instead of letting the driver report
 * the child's own exit code and stderr.
 */
export function writePromptToStdin(child: ChildProcess, prompt: string): void {
  if (!child.stdin) return;
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}
