import { execSafe } from "./utils.js";

// Validates a git ref name / revision argument. Rejects refs that would be
// interpreted as git flags (leading `-`) or that contain shell metacharacters.
// Allows:
//   - branch/tag names: main, feature/foo, v1.0.0
//   - relative refs: HEAD~3, HEAD^, HEAD^2
//   - stash refs: stash@{0}, refs/stash
//   - SHA-like strings: abc1234
// Rejects:
//   - leading `-` (git flag injection)
//   - `..` (range syntax — not a single ref)
//   - shell metacharacters: space, ;, |, &, $, >, <, `, (, ), \, "
export function isValidRef(ref: string): boolean {
  if (ref.startsWith("-")) return false;
  if (ref.includes("..")) return false;
  // Allow word chars, dot, dash, slash, caret, tilde, @, braces — block shell metas
  return /^[\w.\-/^~@{}]+$/.test(ref);
}

export async function runGit(
  args: string[],
  cwd: string,
  opts: {
    signal?: AbortSignal;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execSafe("git", args, {
    cwd,
    signal: opts.signal,
    timeout: opts.timeout ?? 30_000,
    maxBuffer: opts.maxBuffer,
    env: opts.env,
  });
  if (result.timedOut) throw new Error("git command timed out");
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "git command failed",
    );
  return result;
}

/** Convenience wrapper that returns stdout as a string (throws on failure). */
export async function runGitStdout(
  args: string[],
  cwd: string,
  opts: { signal?: AbortSignal; timeout?: number } = {},
): Promise<string> {
  return (await runGit(args, cwd, opts)).stdout;
}

export async function checkGitRepo(
  workspace: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const r = await execSafe("git", ["rev-parse", "--git-dir"], {
    cwd: workspace,
    signal,
  });
  return r.exitCode === 0;
}
