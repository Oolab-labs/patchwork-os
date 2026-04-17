import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface BridgeLock {
  pid: number;
  port: number;
  workspace: string;
  authToken: string;
  isBridge?: boolean;
}

/**
 * Locate a running Patchwork/bridge instance by scanning lock files under
 * ~/.claude/ide/. Prefers locks with isBridge:true whose PID is alive.
 * Callers can pin a specific port via the PATCHWORK_BRIDGE_PORT env var.
 */
export function findBridge(): BridgeLock | null {
  const dir = path.join(os.homedir(), ".claude", "ide");
  if (!fs.existsSync(dir)) return null;
  const pinned = process.env.PATCHWORK_BRIDGE_PORT;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.lock$/.test(f))
    .filter((f) => !pinned || f === `${pinned}.lock`);
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const parsed = JSON.parse(raw) as Partial<BridgeLock>;
      if (!parsed.isBridge) continue;
      if (!parsed.pid || !isPidAlive(parsed.pid)) continue;
      const port = Number.parseInt(f.replace(/\.lock$/, ""), 10);
      if (!Number.isFinite(port)) continue;
      return {
        pid: parsed.pid,
        port,
        workspace: parsed.workspace ?? "",
        authToken: parsed.authToken ?? "",
        isBridge: true,
      };
    } catch {
      // skip malformed locks
    }
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function bridgeFetch(
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const lock = findBridge();
  if (!lock) {
    return new Response(
      JSON.stringify({ error: "No running bridge found in ~/.claude/ide/" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  const url = `http://127.0.0.1:${lock.port}${pathname}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${lock.authToken}`);
  return fetch(url, { ...init, headers });
}
