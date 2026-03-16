import { execSafe } from "./utils.js";

// `..` in a ref is interpreted as a range by git (e.g. main..HEAD) and must not
// appear in a single ref name. Leading `-` would be interpreted by git as a flag.
export function isValidRef(ref: string): boolean {
  return /^[\w.\-/]+$/.test(ref) && !ref.includes("..") && !ref.startsWith("-");
}

export async function runGit(
  args: string[],
  cwd: string,
  opts: { signal?: AbortSignal; timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execSafe("git", args, {
    cwd,
    signal: opts.signal,
    timeout: opts.timeout ?? 30_000,
    maxBuffer: opts.maxBuffer,
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
