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

// 1-second TTL cache for lock-file discovery. The lock file changes only when
// the bridge restarts (new port, new token) — scanning ~/.claude/ide/ on every
// proxied request added readdirSync + statSync + readFileSync + kill(pid,0) per
// call, ~5-10 syscalls each, amplified on every SSE tick. Stale entries expire
// within 1s; a bridge restart triggers re-discovery on the next cache miss.
let _cache: { lock: BridgeLock | null; expires: number } | null = null;
// 5 s TTL (was 1 s). Lock files change only on bridge restart; 5 s stale window
// reduces the scan from ~5 syscalls per proxy request to ~1 per 5 s on Windows
// where each readdirSync + statSync + readFileSync passes through Defender.
const CACHE_TTL_MS = 5_000;

/** Exported for tests only — clears the lock-discovery cache between cases. */
export function _clearBridgeCache(): void {
  _cache = null;
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

  if (_cache && Date.now() < _cache.expires) return _cache.lock;
  const lock = _scanLockFiles();
  _cache = { lock, expires: Date.now() + CACHE_TTL_MS };
  return lock;
}

function _lockDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide");
}

function _scanLockFiles(): BridgeLock | null {
  const dir = _lockDir();
  if (!fs.existsSync(dir)) return null;
  const pinned = process.env.PATCHWORK_BRIDGE_PORT;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.lock$/.test(f))
    .filter((f) => !pinned || f === `${pinned}.lock`)
    .sort((a, b) => {
      // On Windows, statSync triggers NTFS metadata serialisation + Defender
      // per file. Fall through to port-number sort there (consistent enough
      // since the bridge uses a fixed port across restarts).
      if (process.platform !== "win32") {
        try {
          const ma = fs.statSync(path.join(dir, a)).mtimeMs;
          const mb = fs.statSync(path.join(dir, b)).mtimeMs;
          return mb - ma; // most recently modified first
        } catch {
          // fall through
        }
      }
      const pa = Number.parseInt(a, 10);
      const pb = Number.parseInt(b, 10);
      return pa - pb;
    });
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const parsed = JSON.parse(raw) as Partial<BridgeLock>;
      if (!parsed.isBridge) continue;
      if (!parsed.pid || !isPidAlive(parsed.pid)) continue;
      // An empty/missing authToken would still pass every other guard and
      // send `Authorization: Bearer ` (empty) — which the bridge rejects.
      // Skip it so discovery can fall through to a healthy lock instead.
      if (!parsed.authToken) continue;
      const port = Number.parseInt(f.replace(/\.lock$/, ""), 10);
      if (!Number.isFinite(port)) continue;
      return {
        pid: parsed.pid,
        port,
        workspace: parsed.workspace ?? "",
        authToken: parsed.authToken,
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
  } catch (err) {
    // EPERM: we lack permission to signal the process, but it IS running
    // (cross-user or elevated on Windows). Mirror src/bridgeLockDiscovery.ts.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    // ESRCH (or anything else): no such process → dead.
    return false;
  }
}

/**
 * Resolve the upstream URL for a given bridge lock + pathname, honoring the
 * port=0 sentinel that signals a remote VPS deploy. Used by both bridgeFetch()
 * and the SSE passthrough routes so they cannot drift apart.
 */
export function resolveBridgeUrl(
  lock: Pick<BridgeLock, "port">,
  pathname: string,
): string {
  const remoteUrl = process.env.PATCHWORK_BRIDGE_URL;
  if (lock.port === 0 && remoteUrl) {
    return `${remoteUrl.replace(/\/$/, "")}${pathname}`;
  }
  return `http://127.0.0.1:${lock.port}${pathname}`;
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
  const url = resolveBridgeUrl(lock, pathname);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${lock.authToken}`);
  const signal = init?.signal ?? AbortSignal.timeout(8_000);
  return fetch(url, { ...init, headers, cache: "no-store", signal });
}
