import * as vscode from "vscode";

import { BridgeConnection } from "./connection";
import { registerEvents } from "./events";
import { createDebugHandlers } from "./handlers/debug";
import { createDecorationHandlers } from "./handlers/decorations";
import { createFileWatcherHandlers } from "./handlers/fileWatcher";
import { baseHandlers } from "./handlers/index";
import { createLspHandlers } from "./handlers/lsp";
import { createNotebookHandlers } from "./handlers/notebook";
import { createTaskHandlers } from "./handlers/tasks";
import { clearAllTerminalBuffers } from "./handlers/terminal";

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

  const bridge = new BridgeConnection();
  bridge.output = output;
  bridge.statusBar = statusBar;

  // Create handler factories with DI
  const lspHandlers = createLspHandlers({ log: (msg) => bridge.log(msg) });
  const fileWatcherHandlers = createFileWatcherHandlers({
    getBridge: () => bridge,
  });
  const debugHandlers = createDebugHandlers({ getBridge: () => bridge });
  const decorationHandlers = createDecorationHandlers();
  const taskHandlers = createTaskHandlers();
  const notebookHandlers = createNotebookHandlers();

  // Wire up all handlers
  bridge.setHandlers({
    ...baseHandlers,
    ...lspHandlers,
    ...fileWatcherHandlers.handlers,
    ...debugHandlers.handlers,
    ...decorationHandlers.handlers,
    ...taskHandlers.handlers,
    ...notebookHandlers.handlers,
  });

  bridge.setOnDispose(() => {
    fileWatcherHandlers.disposeAll();
    debugHandlers.disposeAll();
    decorationHandlers.disposeAll();
    taskHandlers.disposeAll();
    notebookHandlers.disposeAll();
    clearAllTerminalBuffers();
  });

  // Read user settings
  const config = vscode.workspace.getConfiguration("claudeIdeBridge");
  const logLevel = config.get<string>("logLevel", "info");
  const autoConnect = config.get<boolean>("autoConnect", true);
  const lockFileDir = config.get<string>("lockFileDir", "");

  bridge.logLevel = logLevel;

  bridge.log("Extension activating...");

  // Apply lock file directory override
  if (lockFileDir) {
    bridge.lockDirOverride = lockFileDir;
    bridge.log(`Using custom lock file directory: ${lockFileDir}`);
  }

  registerEvents(context, bridge);
  bridge.startWatchingLockDir();
  if (autoConnect) {
    bridge.tryConnect();
  } else {
    bridge.log("Auto-connect disabled — use 'Claude IDE Bridge: Reconnect' to connect manually");
  }

  context.subscriptions.push({
    dispose() {
      bridge.dispose();
    },
  });
}

export function deactivate(): void {
  // Cleanup happens via dispose() above
}
