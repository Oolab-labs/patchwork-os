import * as vscode from "vscode";
import WebSocket from "ws";

import { BridgeInstaller } from "./bridgeInstaller";
import { BridgeProcess } from "./bridgeProcess";
import { BridgeConnection } from "./connection";
import { registerEvents } from "./events";
import { createDebugHandlers } from "./handlers/debug";
import { createDecorationHandlers } from "./handlers/decorations";
import { createFileWatcherHandlers } from "./handlers/fileWatcher";
import { baseHandlers } from "./handlers/index";
import { createLspHandlers } from "./handlers/lsp";
import { clearAllTerminalBuffers } from "./handlers/terminal";
import {
  readAllMatchingLockFiles,
  readLockFileForWorkspace,
} from "./lockfiles";

/**
 * SecretStorage key for a given workspace path.
 * SecretStorage is available in VS Code 1.53+ and all current forks
 * (Cursor, Windsurf, Google Antigravity).
 */
function secretKey(workspacePath: string): string {
  return `claude-ide-bridge:${workspacePath}`;
}

/**
 * Persist the auth token for a workspace to VS Code SecretStorage after a
 * successful connection. This allows the extension to attempt reconnection
 * immediately if no lock file is found on disk (e.g. during bridge restart).
 * Requires a trusted workspace (vscode.workspace.isTrusted).
 * Wrapped in try/catch — SecretStorage failure must never block startup.
 */
async function storeTokenInSecrets(
  context: vscode.ExtensionContext,
  workspacePath: string,
  authToken: string,
  port: number,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  try {
    const key = secretKey(workspacePath);
    await context.secrets.store(
      key,
      JSON.stringify({ authToken, port, workspace: workspacePath }),
    );
  } catch (err) {
    output.appendLine(
      `${new Date().toISOString()} WARN: Failed to store token in SecretStorage: ${String(err)}`,
    );
  }
}

/**
 * Retrieve a cached LockFileData from SecretStorage for a given workspace.
 * Returns null if SecretStorage fails, the workspace is untrusted, or no entry exists.
 */
async function loadTokenFromSecrets(
  context: vscode.ExtensionContext,
  workspacePath: string,
  output: vscode.OutputChannel,
): Promise<{ authToken: string; port: number; workspace: string } | null> {
  if (!vscode.workspace.isTrusted) return null;
  try {
    const key = secretKey(workspacePath);
    const raw = await context.secrets.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      authToken?: string;
      port?: number;
      workspace?: string;
    };
    if (typeof parsed.authToken !== "string" || typeof parsed.port !== "number")
      return null;
    return {
      authToken: parsed.authToken,
      port: parsed.port,
      workspace: parsed.workspace ?? workspacePath,
    };
  } catch (err) {
    output.appendLine(
      `${new Date().toISOString()} WARN: Failed to read token from SecretStorage: ${String(err)}`,
    );
    return null;
  }
}

/** Shared output channel — kept module-level so deactivate() can log to it. */
let sharedOutput: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Claude IDE Bridge", {
    log: true,
  });
  sharedOutput = output;
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
  const autoInstallBridge = config.get<boolean>("autoInstallBridge", true);
  const autoStartBridge = config.get<boolean>("autoStartBridge", true);

  // ── Handler factories (shared across all connections) ──────────────────────
  // Handlers use the VS Code API which is process-global; they don't need to
  // be instantiated per connection. The factory dependencies that reference a
  // specific bridge (getBridge, log) use the connection that received the request.

  // ── Connection registry ───────────────────────────────────────────────────
  /** Live connections keyed by workspace path (or "" for no-workspace mode). */
  const connections = new Map<string, BridgeConnection>();

  /** Bridge processes spawned by this extension instance, keyed by workspace path. */
  const processes = new Map<string, BridgeProcess>();

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

  async function makeConnection(
    workspacePath: string,
  ): Promise<BridgeConnection> {
    const bridge = new BridgeConnection();
    bridge.output = output;
    bridge.logLevel = logLevel;
    bridge.workspaceOverride = workspacePath;
    bridge.onStateChange = updateStatusBar;

    if (lockFileDir) bridge.lockDirOverride = lockFileDir;

    // Load cached token from SecretStorage as a fallback for when no live lock
    // file is found (e.g. during bridge restart). Best-effort — does not block.
    if (workspacePath) {
      const cached = await loadTokenFromSecrets(context, workspacePath, output);
      if (cached) {
        bridge.lockDataFallback = {
          port: cached.port,
          authToken: cached.authToken,
          pid: -1,
          workspace: cached.workspace,
        };
        output.appendLine(
          `${new Date().toISOString()} SecretStorage: loaded cached token for ${workspacePath} (fallback only)`,
        );
      }
    }

    // After a successful connection, persist the token to SecretStorage so it
    // can be used as a fallback in future sessions.
    if (workspacePath) {
      bridge.onConnected = (lockData) => {
        void storeTokenInSecrets(
          context,
          workspacePath,
          lockData.authToken,
          lockData.port,
          output,
        );
        // Update the fallback with the freshly-connected lock data so subsequent
        // reconnects use the latest port/token.
        bridge.lockDataFallback = lockData;
      };
    }

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

  // In-progress set prevents duplicate connections if syncConnections is called
  // concurrently (e.g. two workspace folders added at once).
  const syncInProgress = new Set<string>();

  /**
   * Sync the connections map to match the current set of workspace folders.
   * Creates connections for new folders, disposes connections for removed folders.
   */
  async function syncConnections(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
      // No workspace — ensure at least one connection exists (no workspace filter)
      if (connections.size === 0 && !syncInProgress.has("")) {
        syncInProgress.add("");
        try {
          const bridge = await makeConnection("");
          connections.set("", bridge);
          bridge.startWatchingLockDir();
          if (autoConnect) bridge.tryConnect();
        } finally {
          syncInProgress.delete("");
        }
      }
      return;
    }

    const activePaths = new Set(folders.map((f) => f.uri.fsPath));

    // Remove connections for folders that are no longer open
    let removedAny = false;
    for (const [ws, bridge] of connections) {
      if (ws !== "" && !activePaths.has(ws)) {
        bridge.dispose();
        connections.delete(ws);
        removedAny = true;
      }
    }
    // Clear terminal buffers once after all stale connections are removed —
    // not once per removed folder to avoid redundant work on multi-root reloads.
    if (removedAny) clearAllTerminalBuffers();

    // Remove the no-workspace fallback if we now have real folders
    if (connections.has("") && folders.length > 0) {
      connections.get("")?.dispose();
      connections.delete("");
    }

    // Add connections for new folders — guard against concurrent calls for the same path
    for (const folder of folders) {
      const fsPath = folder.uri.fsPath;
      if (!connections.has(fsPath) && !syncInProgress.has(fsPath)) {
        syncInProgress.add(fsPath);
        try {
          const bridge = await makeConnection(fsPath);
          // Re-check after await — a concurrent call may have beaten us
          if (!connections.has(fsPath)) {
            connections.set(fsPath, bridge);
            bridge.startWatchingLockDir();

            if (autoConnect) {
              if (
                autoStartBridge &&
                !processes.has(fsPath) &&
                vscode.workspace.isTrusted
              ) {
                // Check if a bridge is already running for this workspace
                const existingLock = await readLockFileForWorkspace(
                  fsPath,
                  lockFileDir || undefined,
                );
                if (existingLock) {
                  bridge.tryConnect();
                } else {
                  // No running bridge — spawn one
                  const proc = new BridgeProcess(
                    output,
                    fsPath,
                    lockFileDir || undefined,
                  );
                  processes.set(fsPath, proc);
                  proc.onStarted = ({ port, authToken, pid }) => {
                    bridge.connectDirect(port, authToken, pid);
                  };
                  proc.onStartupFailed = (err) => {
                    output.appendLine(
                      `${new Date().toISOString()} Bridge startup failed for ${fsPath}: ${err}`,
                    );
                    void vscode.window
                      .showErrorMessage(
                        `Claude IDE Bridge failed to start: ${err}`,
                        "Show Logs",
                      )
                      .then((choice) => {
                        if (choice === "Show Logs") output.show();
                      });
                    // Fall through to normal tryConnect so the extension keeps
                    // watching for a manually-started bridge.
                    bridge.tryConnect();
                  };
                  void proc.spawn();
                }
              } else {
                bridge.tryConnect();
              }
            }
          } else {
            bridge.dispose();
          }
        } finally {
          syncInProgress.delete(fsPath);
        }
      }
    }

    updateStatusBar();
  }

  output.appendLine(`${new Date().toISOString()} Extension activating...`);

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

  // Ensure the bridge binary is installed, then start connections
  const startupSequence = async () => {
    if (!vscode.workspace.isTrusted) {
      output.appendLine(
        `${new Date().toISOString()} Untrusted workspace — skipping bridge install and auto-start.`,
      );
      await syncConnections();
      return;
    }
    if (autoInstallBridge) {
      const installer = new BridgeInstaller(output);
      try {
        await installer.ensureInstalled();
      } catch (err: unknown) {
        // Install failure is non-fatal — log and continue; an older version may work
        output.appendLine(
          `${new Date().toISOString()} WARN: bridge install failed: ${String(err)}`,
        );
      }
    }
    await syncConnections();
  };

  startupSequence().catch((err: unknown) =>
    output.appendLine(
      `${new Date().toISOString()} ERROR: startup sequence failed: ${String(err)}`,
    ),
  );

  context.subscriptions.push({
    dispose() {
      for (const bridge of connections.values()) bridge.dispose();
      connections.clear();
      for (const proc of processes.values()) void proc.stop();
      processes.clear();
      clearAllTerminalBuffers();
    },
  });
}

export function deactivate(): void {
  sharedOutput?.appendLine(
    `${new Date().toISOString()} Extension deactivating`,
  );
  // Active connections and processes are disposed via context.subscriptions
  // (registered in activate()). VS Code calls dispose() on each subscription
  // automatically when the extension is deactivated.
  sharedOutput = null;
}
