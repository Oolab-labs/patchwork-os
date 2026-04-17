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
 * Scan ~/.claude/ide/*.lock and return the first running patchwork bridge
 * (isBridge:true + live PID). Port is parsed from the lockfile name.
 */
export function findBridgeLock(): BridgeLockInfo | null {
  const dir = path.join(os.homedir(), ".claude", "ide");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
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
      try {
        process.kill(parsed.pid, 0);
      } catch {
        continue;
      }
      const port = Number.parseInt(f.replace(/\.lock$/, ""), 10);
      if (!Number.isFinite(port)) continue;
      return {
        port,
        authToken: parsed.authToken ?? "",
        pid: parsed.pid,
        workspace: parsed.workspace ?? "",
      };
    } catch {
      // skip malformed lock
    }
  }
  return null;
}
