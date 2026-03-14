import * as vscode from "vscode";
import WebSocket from "ws";

import { BridgeConnection } from "./connection";
import { registerEvents } from "./events";
import { createDebugHandlers } from "./handlers/debug";
import { createDecorationHandlers } from "./handlers/decorations";
import { createFileWatcherHandlers } from "./handlers/fileWatcher";
import { baseHandlers } from "./handlers/index";
import { createLspHandlers } from "./handlers/lsp";
import { clearAllTerminalBuffers } from "./handlers/terminal";
import { readAllMatchingLockFiles } from "./lockfiles";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Claude IDE Bridge");
  context.subscriptions.push(output);

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBar.command = "claudeIdeBridge.reconnect";
  statusBar.text = "$(debug-disconnect) Claude Bridge";
  statusBar.tooltip = "Claude IDE Bridge: Disconnected";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Read user settings
  const config = vscode.workspace.getConfiguration("claudeIdeBridge");
  const logLevel = config.get<string>("logLevel", "info");
  const autoConnect = config.get<boolean>("autoConnect", true);
  const lockFileDir = config.get<string>("lockFileDir", "");

  // ── Handler factories (shared across all connections) ──────────────────────
  // Handlers use the VS Code API which is process-global; they don't need to
  // be instantiated per connection. The factory dependencies that reference a
  // specific bridge (getBridge, log) use the connection that received the request.

  // ── Connection registry ───────────────────────────────────────────────────
  /** Live connections keyed by workspace path (or "" for no-workspace mode). */
  const connections = new Map<string, BridgeConnection>();

  function getBridges(): BridgeConnection[] {
    return [...connections.values()];
  }

  function updateStatusBar(): void {
    const all = getBridges();
    const connected = all.filter(
      (b) => b.ws?.readyState === WebSocket.OPEN,
    ).length;
    const total = all.length;
    if (total === 0 || connected === 0) {
      statusBar.text = "$(debug-disconnect) Claude Bridge";
      statusBar.tooltip = "Claude IDE Bridge: Disconnected";
    } else if (connected < total) {
      statusBar.text = `$(sync~spin) Claude Bridge ${connected}/${total}`;
      statusBar.tooltip = `Claude IDE Bridge: ${connected}/${total} bridges connected`;
    } else {
      const anyClaudeActive = all.some((b) => b.claudeConnected);
      statusBar.text = anyClaudeActive
        ? "$(check) Claude Bridge"
        : "$(plug) Claude Bridge";
      statusBar.tooltip = anyClaudeActive
        ? `Claude IDE Bridge: Connected — Claude Code active (${total} bridge${total > 1 ? "s" : ""})`
        : `Claude IDE Bridge: Connected — waiting for Claude Code (${total} bridge${total > 1 ? "s" : ""})`;
    }
  }

  function makeConnection(workspacePath: string): BridgeConnection {
    const bridge = new BridgeConnection();
    bridge.output = output;
    bridge.logLevel = logLevel;
    bridge.workspaceOverride = workspacePath;
    bridge.onStateChange = updateStatusBar;

    if (lockFileDir) bridge.lockDirOverride = lockFileDir;

    // Create per-connection handler factories that reference this bridge
    const lspHandlers = createLspHandlers({ log: (msg) => bridge.log(msg) });
    const fileWatcherHandlers = createFileWatcherHandlers({
      getBridge: () => bridge,
    });
    const debugHandlers = createDebugHandlers({ getBridge: () => bridge });
    const decorationHandlers = createDecorationHandlers();

    bridge.setHandlers({
      ...baseHandlers,
      ...lspHandlers,
      ...fileWatcherHandlers.handlers,
      ...debugHandlers.handlers,
      ...decorationHandlers.handlers,
    });

    bridge.setOnDispose(() => {
      fileWatcherHandlers.disposeAll();
      debugHandlers.disposeAll();
      decorationHandlers.disposeAll();
    });

    return bridge;
  }

  /**
   * Sync the connections map to match the current set of workspace folders.
   * Creates connections for new folders, disposes connections for removed folders.
   */
  async function syncConnections(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
      // No workspace — ensure at least one connection exists (no workspace filter)
      if (connections.size === 0) {
        const bridge = makeConnection("");
        connections.set("", bridge);
        bridge.startWatchingLockDir();
        if (autoConnect) bridge.tryConnect();
      }
      return;
    }

    const activePaths = new Set(folders.map((f) => f.uri.fsPath));

    // Remove connections for folders that are no longer open
    for (const [ws, bridge] of connections) {
      if (ws !== "" && !activePaths.has(ws)) {
        bridge.dispose();
        clearAllTerminalBuffers();
        connections.delete(ws);
      }
    }

    // Remove the no-workspace fallback if we now have real folders
    if (connections.has("") && folders.length > 0) {
      connections.get("")?.dispose();
      connections.delete("");
    }

    // Add connections for new folders
    for (const folder of folders) {
      const fsPath = folder.uri.fsPath;
      if (!connections.has(fsPath)) {
        const bridge = makeConnection(fsPath);
        connections.set(fsPath, bridge);
        bridge.startWatchingLockDir();
        if (autoConnect) bridge.tryConnect();
      }
    }

    updateStatusBar();
  }

  output.appendLine(
    `${new Date().toISOString()} Extension activating...`,
  );

  registerEvents(context, getBridges, output);

  // Watch for workspace folder changes (multi-root support)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncConnections().catch((err: unknown) =>
        output.appendLine(
          `${new Date().toISOString()} ERROR: syncConnections failed: ${String(err)}`,
        ),
      );
    }),
  );

  // Initial sync
  syncConnections().catch((err: unknown) =>
    output.appendLine(
      `${new Date().toISOString()} ERROR: initial syncConnections failed: ${String(err)}`,
    ),
  );

  context.subscriptions.push({
    dispose() {
      for (const bridge of connections.values()) bridge.dispose();
      connections.clear();
      clearAllTerminalBuffers();
    },
  });
}

export function deactivate(): void {
  // Cleanup happens via dispose() above
}
