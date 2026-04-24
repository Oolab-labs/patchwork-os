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
 * Callers can pin a specific port via PATCHWORK_BRIDGE_PORT in .env.local.
 *
 * Remote VPS deploy: when PATCHWORK_BRIDGE_URL + PATCHWORK_BRIDGE_TOKEN are
 * both set, lock-file discovery is skipped entirely. port=0 is a sentinel
 * value — bridgeFetch() detects it and uses the remote URL instead.
 */
export function findBridge(): BridgeLock | null {
  const remoteUrl = process.env.PATCHWORK_BRIDGE_URL;
  const remoteToken = process.env.PATCHWORK_BRIDGE_TOKEN;
  if (remoteUrl && remoteToken) {
    return {
      pid: 0,
      port: 0,
      workspace: "",
      authToken: remoteToken,
      isBridge: true,
    };
  }

  const dir = path.join(os.homedir(), ".claude", "ide");
  if (!fs.existsSync(dir)) return null;
  const pinned = process.env.PATCHWORK_BRIDGE_PORT;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.lock$/.test(f))
    .sort((a, b) => {
      const pa = Number.parseInt(a, 10);
      const pb = Number.parseInt(b, 10);
      return pa - pb;
    })
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
  // port=0 is the sentinel set by findBridge() when remote env vars are present
  const remoteUrl = process.env.PATCHWORK_BRIDGE_URL;
  const url =
    lock.port === 0 && remoteUrl
      ? `${remoteUrl.replace(/\/$/, "")}${pathname}`
      : `http://127.0.0.1:${lock.port}${pathname}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${lock.authToken}`);
  return fetch(url, { ...init, headers, cache: "no-store" });
}
