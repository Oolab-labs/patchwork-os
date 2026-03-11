import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { LOCK_DIR } from "./constants";
import type { LockFileData } from "./types";

// Async version — preferred to avoid blocking the extension host thread
export async function readLockFilesAsync(
  lockDir?: string,
): Promise<LockFileData | null> {
  const dir = lockDir || LOCK_DIR;
  try {
    try {
      await fsp.access(dir);
    } catch {
      return null;
    }
    const allFiles = await fsp.readdir(dir);
    const files = allFiles.filter((f) => f.endsWith(".lock"));
    const currentWorkspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

    // Sort by modification time (newest first) to prefer the most recent bridge
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

    for (const { file } of stats) {
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

        // Guard against PID reuse: startedAt is required; if absent treat the
        // lock as invalid (epoch 0 will always exceed the age threshold).
        const startedAt: number =
          typeof content.startedAt === "number" ? content.startedAt : 0;
        const ageMs = Date.now() - startedAt;
        // Reduce window from 24 h to 2 h — bridges don't run for days without
        // reconnecting, and a shorter window greatly limits PID-reuse exposure.
        if (ageMs > 2 * 60 * 60 * 1000) continue;

        if (currentWorkspace && content.workspace) {
          if (
            path.resolve(content.workspace) !== path.resolve(currentWorkspace)
          )
            continue;
        }

        return {
          port,
          authToken: content.authToken,
          pid: content.pid,
          workspace: content.workspace,
        };
      } catch {}
    }
  } catch {
    // Lock dir doesn't exist or can't read
  }
  return null;
}
