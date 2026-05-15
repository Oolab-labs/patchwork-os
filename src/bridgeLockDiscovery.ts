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
}

function defaultIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultLockDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide");
}

/**
 * Scan ~/.claude/ide/*.lock and return the first running patchwork bridge
 * (isBridge:true + live PID). Port is parsed from the lockfile name.
 */
export function findBridgeLock(
  deps: LockDiscoveryDeps = {},
): BridgeLockInfo | null {
  const all = findAllLiveBridges(deps);
  return all[0] ?? null;
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
      if (!isLive(parsed.pid)) continue;
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
