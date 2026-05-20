/**
 * Recipe workspace-root resolution.
 *
 * The bridge LaunchAgent sets `WorkingDirectory: __HOME__`, so recipe
 * agent-step subprocesses spawned by the bridge inherit `$HOME` as cwd.
 * Steps that shell out to `git log` / `npm audit` / project scripts then
 * fail with `fatal: not a git repository` and the recipe runner records
 * the catch-all `agent_silent_fail` halt — diagnosed by the 2026-05-20
 * `improvement-research` run (231/232 halts) as proposal P2.
 *
 * This module returns a resolved workspace root the runner can use as
 * `cwd:` on spawn. When nothing is resolvable the caller must halt with a
 * typed reason (`recipe_no_workspace`) — never run steps against `$HOME`.
 *
 * Resolution precedence (highest first):
 *   1. `explicitPath`         — from a recipe-level `workspace:` field
 *   2. `PATCHWORK_WORKSPACE`  — env var
 *   3. Walk up from `startDir` (default `process.cwd()`) for `.git`
 *   4. `null`
 *
 * Each candidate must exist on disk; a non-existent explicit/env path
 * returns null so the caller halts loudly instead of silently spawning
 * against a missing directory.
 */

import { statSync } from "node:fs";
import path from "node:path";

export interface WorkspaceRoot {
  /** Absolute path. */
  path: string;
  /** Which resolution rule fired — for logging and halt-reason context. */
  source: "explicit" | "env" | "git-ancestor";
}

export interface ResolveWorkspaceRootOptions {
  /** Directory to begin the `.git` ancestor walk from. Default: `process.cwd()`. */
  startDir?: string;
  /** Recipe-level `workspace:` field, if any. */
  explicitPath?: string;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function gitMarkerExists(dir: string): boolean {
  // `.git` is a directory in normal clones and a file in git-worktrees.
  try {
    statSync(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function walkUpForGit(startDir: string): string | null {
  let current = path.resolve(startDir);
  // Bounded walk: stop at filesystem root (`path.dirname(root) === root`).
  for (;;) {
    if (gitMarkerExists(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveWorkspaceRoot(
  options: ResolveWorkspaceRootOptions = {},
): WorkspaceRoot | null {
  const { explicitPath, startDir = process.cwd() } = options;

  if (explicitPath && explicitPath.length > 0) {
    const resolved = path.resolve(explicitPath);
    return dirExists(resolved) ? { path: resolved, source: "explicit" } : null;
  }

  const envPath = process.env.PATCHWORK_WORKSPACE;
  if (envPath && envPath.length > 0) {
    const resolved = path.resolve(envPath);
    return dirExists(resolved) ? { path: resolved, source: "env" } : null;
  }

  const gitRoot = walkUpForGit(startDir);
  if (gitRoot) return { path: gitRoot, source: "git-ancestor" };

  return null;
}
