import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BridgeLockInfo {
  port: number;
  authToken: string;
  pid: number;
  workspace: string;
}

/**
 * Test-injection seam for the `~/.claude/ide` directory location. The
 * defaults read from `os.homedir()` exactly as before; tests pass a
 * temp dir + a synthetic `process.kill(pid, 0)` substitute so the
 * lock-discovery walk can be exercised without touching the real
 * filesystem or real PIDs.
 */
export interface LockDiscoveryDeps {
  /** Directory to scan. Defaults to `~/.claude/ide`. */
  lockDir?: string;
  /** Returns true if the PID is live; production default = `process.kill(pid, 0)`. */
  isLive?: (pid: number) => boolean;
  /**
   * Caller's working directory, used to disambiguate when MORE THAN ONE live
   * bridge is present: `findBridgeLock` prefers the bridge whose `workspace`
   * contains this path. Defaults to `process.cwd()`. (A bare `claude-ide-bridge
   * shim` with no `--workspace` would otherwise pick whichever isBridge lock
   * `readdir` happens to return first — non-deterministic across filesystems.)
   */
  cwd?: string;
}

/**
 * Normalize a path for cross-platform comparison: resolve it, convert
 * backslashes to forward slashes, and (on Windows only) lowercase it — NTFS
 * paths are case-insensitive but VS Code / a terminal-spawned process can
 * report the same path with different drive-letter/segment casing.
 */
function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when `cwd` is the workspace root or a descendant of it. Exported for
 * direct unit testing of the cross-platform (case/slash) comparison rules —
 * `findBridgeLock`'s own tests otherwise depend on non-deterministic
 * `readdir` ordering to observe which candidate wins.
 */
export function cwdInWorkspace(cwd: string, workspace: string): boolean {
  if (!workspace) return false;
  const normCwd = normalizePathForComparison(cwd);
  const normWorkspace = normalizePathForComparison(workspace);
  const rel = path.posix.relative(normWorkspace, normCwd);
  return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
}

function defaultIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: we lack permission to signal the process, but it IS running
    // (cross-user or elevated on Windows). Mirror lockfile.ts:199–215.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    // ESRCH: no such process → dead.
    return false;
  }
}

function defaultLockDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide");
}

/**
 * Scan ~/.claude/ide/*.lock and return one running patchwork bridge
 * (isBridge:true + live PID). Port is parsed from the lockfile name.
 *
 * With a single live bridge this is byte-identical to "the only one". With
 * MULTIPLE live bridges (a multi-workspace deployment, or a stale-but-live
 * sibling), it prefers the bridge whose `workspace` contains the caller's cwd
 * — so a no-`--workspace` shim deterministically attaches to the bridge for the
 * project it is actually running in, instead of whatever `readdir` returned
 * first. Falls back to the first when no workspace matches.
 */
export function findBridgeLock(
  deps: LockDiscoveryDeps = {},
): BridgeLockInfo | null {
  const all = findAllLiveBridges(deps);
  if (all.length <= 1) return all[0] ?? null;
  const cwd = deps.cwd ?? process.cwd();
  const match = all.find((b) => cwdInWorkspace(cwd, b.workspace));
  return match ?? all[0] ?? null;
}

/**
 * Scan ~/.claude/ide/*.lock and return **every** running patchwork bridge
 * (isBridge:true + live PID), in filesystem-readdir order.
 *
 * Used by `patchwork kill-switch engage/release` to fan out to every
 * live bridge — per [#422](https://github.com/Oolab-labs/patchwork-os/issues/422) v2-B2, a single-bridge-only kill-switch would
 * leave sibling bridges in a multi-workspace deployment writing through
 * the gate, defeating the emergency-stop semantics.
 *
 * Returns `[]` when the lock dir is missing or contains no live bridges.
 * Malformed lock files are silently skipped.
 */
export function findAllLiveBridges(
  deps: LockDiscoveryDeps = {},
): BridgeLockInfo[] {
  const dir = deps.lockDir ?? defaultLockDir();
  const isLive = deps.isLive ?? defaultIsLive;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BridgeLockInfo[] = [];
  for (const f of entries) {
    if (!/^\d+\.lock$/.test(f)) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as {
        pid?: number;
        authToken?: string;
        workspace?: string;
        isBridge?: boolean;
      };
      if (!parsed.isBridge) continue;
      if (!parsed.pid) continue;
      // isLive can throw when process.kill(pid,0) throws EPERM (cross-user /
      // elevated process on Windows). EPERM means the process IS alive — we
      // just lack permission to signal it. Any other throw (ESRCH, etc.) means
      // dead. Mirror defaultIsLive + lockfile.ts:199–215.
      let live: boolean;
      try {
        live = isLive(parsed.pid);
      } catch (liveErr) {
        live = (liveErr as NodeJS.ErrnoException).code === "EPERM";
      }
      if (!live) continue;
      const port = Number.parseInt(f.replace(/\.lock$/, ""), 10);
      if (!Number.isFinite(port)) continue;
      out.push({
        port,
        authToken: parsed.authToken ?? "",
        pid: parsed.pid,
        workspace: parsed.workspace ?? "",
      });
    } catch {
      // skip malformed lock
    }
  }
  return out;
}
