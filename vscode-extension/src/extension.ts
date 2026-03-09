import * as vscode from "vscode";

import { BridgeConnection } from "./connection";
import { baseHandlers } from "./handlers/index";
import { createLspHandlers } from "./handlers/lsp";
import { createFileWatcherHandlers } from "./handlers/fileWatcher";
import { createDebugHandlers } from "./handlers/debug";
import { createDecorationHandlers } from "./handlers/decorations";
import { createTaskHandlers } from "./handlers/tasks";
import { createNotebookHandlers } from "./handlers/notebook";
import { clearAllTerminalBuffers } from "./handlers/terminal";
import { registerEvents } from "./events";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Claude IDE Bridge");
  context.subscriptions.push(output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
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
  const fileWatcherHandlers = createFileWatcherHandlers({ getBridge: () => bridge });
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

  bridge.log("Extension activating...");

  registerEvents(context, bridge);
  bridge.startWatchingLockDir();
  bridge.tryConnect();

  context.subscriptions.push({
    dispose() {
      bridge.dispose();
    },
  });
}

export function deactivate(): void {
  // Cleanup happens via dispose() above
}
