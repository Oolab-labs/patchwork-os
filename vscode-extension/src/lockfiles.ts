import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import { LOCK_DIR } from "./constants";
import type { LockFileData } from "./types";

// Async version — preferred to avoid blocking the extension host thread
export async function readLockFilesAsync(): Promise<LockFileData | null> {
  try {
    try {
      await fsp.access(LOCK_DIR);
    } catch {
      return null;
    }
    const allFiles = await fsp.readdir(LOCK_DIR);
    const files = allFiles.filter((f) => f.endsWith(".lock"));
    const currentWorkspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

    // Sort by modification time (newest first) to prefer the most recent bridge
    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const stat = await fsp.stat(path.join(LOCK_DIR, f));
          return { file: f, mtimeMs: stat.mtimeMs };
        } catch {
          return { file: f, mtimeMs: 0 };
        }
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file } of stats) {
      try {
        const raw = await fsp.readFile(path.join(LOCK_DIR, file), "utf-8");
        const content = JSON.parse(raw);

        const port = parseInt(path.basename(file, ".lock"), 10);
        if (isNaN(port)) continue;
        if (!content.authToken) continue;

        try {
          process.kill(content.pid, 0);
        } catch {
          continue;
        }

        if (currentWorkspace && content.workspace) {
          if (content.workspace !== currentWorkspace) continue;
        }

        return {
          port,
          authToken: content.authToken,
          pid: content.pid,
          workspace: content.workspace,
        };
      } catch {
        continue;
      }
    }
  } catch {
    // Lock dir doesn't exist or can't read
  }
  return null;
}

