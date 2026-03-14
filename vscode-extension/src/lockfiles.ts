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

        try {
          process.kill(content.pid, 0);
        } catch {
          continue;
        }

        // Guard against PID reuse: startedAt is required.
        const startedAt: number =
          typeof content.startedAt === "number" ? content.startedAt : 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs > 2 * 60 * 60 * 1000) continue;

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

/** Return the best lock file matching the first VS Code workspace folder (existing behaviour). */
export async function readLockFilesAsync(
  lockDir?: string,
): Promise<LockFileData | null> {
  const currentWorkspace =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const candidates = await readValidLockFiles(lockDir);
  for (const candidate of candidates) {
    if (currentWorkspace && candidate.workspace) {
      if (
        path.resolve(candidate.workspace) !== path.resolve(currentWorkspace)
      )
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
    if (candidate.workspace && path.resolve(candidate.workspace) !== resolved)
      continue;
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
    return candidates.length > 0 ? [candidates[0]] : [];
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
