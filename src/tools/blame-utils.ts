import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MAX = 1_000;

export interface BlameEntry {
  commitHash: string;
  cachedAt: number;
}

export interface BlameCacheOptions {
  /** Cache TTL in ms. Default 30s. */
  ttlMs?: number;
  /** Git blame subprocess timeout in ms. Default 2s. */
  timeoutMs?: number;
  /** FIFO cache size cap. Default 1000. */
  maxSize?: number;
  /** Test hook — default Date.now. */
  now?: () => number;
}

/**
 * Factory for a per-instance git-blame resolver with LRU cache, subprocess
 * timeout, and stale-file guard. Used by watchDiagnostics (enriches
 * diagnostics with introducing commit) and enrichStackTrace (maps stack
 * frames to commits).
 *
 * Returns `undefined` for untracked files, deleted files, blame misses, and
 * the all-zeros "uncommitted" sentinel — callers treat those as "unknown"
 * rather than error.
 */
export function createBlameResolver(
  workspace: string,
  options: BlameCacheOptions = {},
) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSize = options.maxSize ?? DEFAULT_CACHE_MAX;
  const now = options.now ?? Date.now;
  const cache = new Map<string, BlameEntry>();

  function evict(): void {
    if (cache.size <= maxSize) return;
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }

  async function getIntroducedByCommit(
    file: string,
    line: number,
  ): Promise<string | undefined> {
    const key = `${file}:${line}`;
    const cached = cache.get(key);
    if (cached && now() - cached.cachedAt < ttlMs) {
      return cached.commitHash;
    }
    // Skip subprocess for files that no longer exist on disk.
    if (!existsSync(file)) return undefined;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["blame", "-L", `${line},${line}`, "--porcelain", "--", file],
        { cwd: workspace, timeout: timeoutMs },
      );
      const hash = stdout.slice(0, 40).trim();
      if (/^[0-9a-f]{40}$/.test(hash) && !hash.startsWith("0000000")) {
        cache.set(key, { commitHash: hash, cachedAt: now() });
        evict();
        return hash;
      }
    } catch {
      // git not available, file not tracked, timeout — silently omit
    }
    return undefined;
  }

  return {
    getIntroducedByCommit,
    cacheSize: () => cache.size,
    clearCache: () => cache.clear(),
  };
}

export type BlameResolver = ReturnType<typeof createBlameResolver>;
