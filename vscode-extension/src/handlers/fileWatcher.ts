import * as vscode from "vscode";
import { MAX_WATCHERS } from "../constants";
import type { RequestHandler } from "../types";

interface FileWatcherDeps {
  getBridge: () => { sendNotification(method: string, params: Record<string, unknown>): void } | null;
}

export function createFileWatcherHandlers(deps: FileWatcherDeps) {
  const activeWatchers = new Map<string, vscode.FileSystemWatcher>();

  const handleWatchFiles: RequestHandler = async (params) => {
    const pattern = params.pattern as string;
    const id = params.id as string;

    if (!pattern || !id) {
      return { watching: false, error: "Both 'id' and 'pattern' are required" };
    }
    if (typeof pattern !== "string" || pattern.startsWith("/") || pattern.includes("..")) {
      return { watching: false, error: "pattern must be a relative glob (e.g. '**/*.ts') — absolute paths and '..' are not allowed" };
    }

    if (activeWatchers.size >= MAX_WATCHERS && !activeWatchers.has(id)) {
      return {
        watching: false,
        error: `Maximum ${MAX_WATCHERS} concurrent watchers reached. Unwatch one first.`,
      };
    }

    const existing = activeWatchers.get(id);
    if (existing) existing.dispose();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { watching: false, error: "No workspace folder open" };
    }
    const relPattern = new vscode.RelativePattern(workspaceFolder, pattern);
    const watcher = vscode.workspace.createFileSystemWatcher(relPattern);
    activeWatchers.set(id, watcher);

    const bridge = deps.getBridge();
    if (!bridge) {
      watcher.dispose();
      activeWatchers.delete(id);
      return { watching: false, error: "Bridge not active" };
    }

    const notify = (type: string, uri: vscode.Uri) => {
      try {
        deps.getBridge()?.sendNotification("extension/fileChanged", {
          id,
          type,
          file: uri.fsPath,
        });
      } catch {
        // Swallow notification errors to avoid destabilizing the watcher callback
      }
    };

    watcher.onDidCreate((uri) => notify("created", uri));
    watcher.onDidChange((uri) => notify("changed", uri));
    watcher.onDidDelete((uri) => notify("deleted", uri));

    return { watching: true, id, pattern };
  };

  const handleUnwatchFiles: RequestHandler = async (params) => {
    const id = params.id as string;
    if (!id) return { unwatched: false, error: "'id' is required" };

    const watcher = activeWatchers.get(id);
    if (watcher) {
      watcher.dispose();
      activeWatchers.delete(id);
      return { unwatched: true, id };
    }
    return { unwatched: false, error: "No watcher with this ID" };
  };

  function disposeAll(): void {
    for (const [, watcher] of activeWatchers) {
      watcher.dispose();
    }
    activeWatchers.clear();
  }

  return {
    handlers: {
      "extension/watchFiles": handleWatchFiles,
      "extension/unwatchFiles": handleUnwatchFiles,
    },
    disposeAll,
  };
}
