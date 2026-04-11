import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { LOCK_DIR } from "./constants";
import type { LockFileData } from "./types";

// ── Internal helper ───────────────────────────────────────────────────────────

/** Read all valid, live lock files and return their parsed data sorted newest first. */
async function readValidLockFiles(
  lockDir?: string,
): Promise<Array<LockFileData & { mtimeMs: number }>> {
  const dir = lockDir || LOCK_DIR;
  const results: Array<LockFileData & { mtimeMs: number }> = [];
  try {
    try {
      await fsp.access(dir);
    } catch {
      return results;
    }
    const allFiles = await fsp.readdir(dir);
    const files = allFiles.filter((f) => f.endsWith(".lock"));

    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const stat = await fsp.stat(path.join(dir, f));
          return { file: f, mtimeMs: stat.mtimeMs };
        } catch {
          return { file: f, mtimeMs: 0 };
        }
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file, mtimeMs } of stats) {
      try {
        const raw = await fsp.readFile(path.join(dir, file), "utf-8");
        const content = JSON.parse(raw);

        const port = Number.parseInt(path.basename(file, ".lock"), 10);
        if (Number.isNaN(port)) continue;
        if (!content.authToken) continue;
        // Only bridge-owned locks are valid candidates. IDE-owned locks
        // (e.g. Windsurf's own lock file without isBridge) must be skipped so
        // they don't fool the auto-start gate into thinking a bridge is running.
        if (!content.isBridge) continue;

        try {
          process.kill(content.pid, 0);
        } catch (err: unknown) {
          // ESRCH → process is dead → stale lock, skip it.
          // EPERM → process exists but is owned by a different user (e.g. remote
          //         SSH, container) → treat as alive and proceed.
          // Any other error → conservative: treat as dead.
          if ((err as NodeJS.ErrnoException).code !== "EPERM") continue;
        }

        // Guard against PID reuse: startedAt is required.
        // 24-hour window: bridges running for longer than this are treated as
        // stale — a PID that old has almost certainly been reused on a system
        // that has been up for more than a day. 2 hours was too aggressive and
        // caused the extension to drop valid lock files on long-running sessions.
        const startedAt: number =
          typeof content.startedAt === "number" ? content.startedAt : 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs > 24 * 60 * 60 * 1000) continue;

        results.push({
          port,
          authToken: content.authToken,
          pid: content.pid,
          workspace: content.workspace,
          mtimeMs,
        });
      } catch {}
    }
  } catch {
    // Lock dir doesn't exist or can't read
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the best lock file matching the first VS Code workspace folder (existing behaviour).
 *
 * Note: intentionally more permissive than `readLockFileForWorkspace` — if either side
 * has no workspace field (legacy bridge or no open folder), the candidate is returned
 * anyway. This preserves backwards-compatibility for single-window setups where the
 * bridge may have been started without a workspace argument.
 */
export async function readLockFilesAsync(
  lockDir?: string,
): Promise<LockFileData | null> {
  const currentWorkspace =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const candidates = await readValidLockFiles(lockDir);
  if (candidates.length > 1) {
    const ports = candidates.map((c) => c.port).join(", ");
    vscode.window.showWarningMessage(
      `Claude IDE Bridge: Multiple bridge instances found (ports ${ports}). Connecting to port ${candidates[0]?.port}. Stop other instances if this is wrong.`,
    );
  }
  for (const candidate of candidates) {
    if (currentWorkspace && candidate.workspace) {
      if (path.resolve(candidate.workspace) !== path.resolve(currentWorkspace))
        continue;
    }
    return candidate;
  }
  return null;
}

/** Return the best lock file matching a specific workspace path. */
export async function readLockFileForWorkspace(
  workspace: string,
  lockDir?: string,
): Promise<LockFileData | null> {
  const candidates = await readValidLockFiles(lockDir);
  const resolved = path.resolve(workspace);
  for (const candidate of candidates) {
    // Skip candidates with no workspace field — they must not match a specific
    // workspace query or they could connect to the wrong bridge in multi-root setups.
    if (!candidate.workspace) continue;
    if (path.resolve(candidate.workspace) !== resolved) continue;
    return candidate;
  }
  return null;
}

/**
 * Return one lock file per VS Code workspace folder (for multi-root workspaces).
 * Folders with no matching bridge are silently omitted.
 */
export async function readAllMatchingLockFiles(
  lockDir?: string,
): Promise<LockFileData[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    // No workspace folders — return the newest available lock file (if any)
    const candidates = await readValidLockFiles(lockDir);
    return candidates.length > 0 ? [candidates[0] as LockFileData] : [];
  }

  const candidates = await readValidLockFiles(lockDir);
  const results: LockFileData[] = [];
  const seenPorts = new Set<number>();

  for (const folder of folders) {
    const resolved = path.resolve(folder.uri.fsPath);
    const match = candidates.find(
      (c) => c.workspace && path.resolve(c.workspace) === resolved,
    );
    if (match && !seenPorts.has(match.port)) {
      seenPorts.add(match.port);
      results.push(match);
    }
  }
  return results;
}
