import * as vscode from "vscode";
import WebSocket from "ws";

import {
  SELECTION_DEBOUNCE,
  DIAGNOSTICS_DEBOUNCE,
  AI_COMMENTS_DEBOUNCE,
  MAX_DIAGNOSTICS_PER_FILE,
  MAX_SELECTED_TEXT_BYTES,
} from "./constants";
import { diagnosticToJson } from "./handlers/diagnostics";
import { scanDocumentForAIComments, scanAllOpenDocuments, invalidateDocumentCache } from "./handlers/aiComments";
import {
  getOrCreateBuffer,
  deleteTerminalBuffer,
  writeToRingBuffer,
  setOutputCaptureEnabled,
} from "./handlers/terminal";
import type { BridgeConnection } from "./connection";

export function registerEvents(
  context: vscode.ExtensionContext,
  bridge: BridgeConnection,
): void {
  // Diagnostics changes (debounced, batched into single message)
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      if (!bridge.ws) return; // Skip work when disconnected
      for (const uri of e.uris) {
        bridge.pendingDiagnosticUris.add(uri.toString());
      }
      if (bridge.diagnosticsDebounceTimer)
        clearTimeout(bridge.diagnosticsDebounceTimer);
      bridge.diagnosticsDebounceTimer = setTimeout(() => {
        for (const uriStr of bridge.pendingDiagnosticUris) {
          const uri = vscode.Uri.parse(uriStr);
          const diags = vscode.languages.getDiagnostics(uri);
          bridge.sendNotification("extension/diagnosticsChanged", {
            file: uri.fsPath,
            diagnostics: diags.slice(0, MAX_DIAGNOSTICS_PER_FILE).map(diagnosticToJson),
          });
        }
        bridge.pendingDiagnosticUris.clear();
      }, DIAGNOSTICS_DEBOUNCE);
    }),
  );

  // Selection changes (debounced)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!bridge.ws) return; // Skip work when disconnected
      if (bridge.selectionDebounceTimer)
        clearTimeout(bridge.selectionDebounceTimer);
      bridge.selectionDebounceTimer = setTimeout(() => {
        const sel = e.selections[0];
        if (!sel) return;
        let selectedText = e.textEditor.document.getText(sel);
        if (Buffer.byteLength(selectedText, "utf-8") > MAX_SELECTED_TEXT_BYTES) {
          // Truncate by bytes, not characters, to respect the byte limit for multi-byte text
          selectedText = Buffer.from(selectedText, "utf-8").subarray(0, MAX_SELECTED_TEXT_BYTES).toString("utf-8");
        }
        bridge.sendNotification("extension/selectionChanged", {
          file: e.textEditor.document.uri.fsPath,
          startLine: sel.start.line + 1,
          startColumn: sel.start.character + 1,
          endLine: sel.end.line + 1,
          endColumn: sel.end.character + 1,
          selectedText,
        });
      }, SELECTION_DEBOUNCE);
    }),
  );

  // Active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        bridge.sendNotification("extension/activeFileChanged", {
          file: editor.document.uri.fsPath,
        });
      }
    }),
  );

  // AI comment scanning (debounced, tracks all changed docs in the debounce window)
  const pendingAICommentDocs = new Map<string, vscode.TextDocument>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!bridge.ws) return; // Skip work when disconnected
      if (e.document.uri.scheme !== "file") return;
      pendingAICommentDocs.set(e.document.uri.toString(), e.document);
      if (bridge.aiCommentsDebounceTimer)
        clearTimeout(bridge.aiCommentsDebounceTimer);
      bridge.aiCommentsDebounceTimer = setTimeout(() => {
        // Invalidate and re-scan all docs that changed during the debounce window
        for (const [uriStr, doc] of pendingAICommentDocs) {
          invalidateDocumentCache(uriStr);
          scanDocumentForAIComments(doc);
        }
        pendingAICommentDocs.clear();
        const allComments = scanAllOpenDocuments();
        bridge.sendNotification("extension/aiCommentsChanged", {
          comments: allComments,
        });
      }, AI_COMMENTS_DEBOUNCE);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      const comments = scanDocumentForAIComments(doc);
      if (comments.length > 0) {
        if (bridge.aiCommentsDebounceTimer)
          clearTimeout(bridge.aiCommentsDebounceTimer);
        bridge.aiCommentsDebounceTimer = setTimeout(() => {
          const allComments = scanAllOpenDocuments();
          bridge.sendNotification("extension/aiCommentsChanged", {
            comments: allComments,
          });
        }, AI_COMMENTS_DEBOUNCE);
      }
    }),
  );

  // File saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      bridge.sendNotification("extension/fileSaved", {
        file: doc.uri.fsPath,
      });
    }),
  );

  // Terminal lifecycle tracking
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      getOrCreateBuffer(terminal);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      deleteTerminalBuffer(terminal);
    }),
  );

  // Terminal output capture (proposed API — graceful degradation)
  try {
    const onDidWriteTerminalData = (vscode.window as any).onDidWriteTerminalData;
    if (typeof onDidWriteTerminalData === "function") {
      const disposable = onDidWriteTerminalData((e: { terminal: vscode.Terminal; data: string }) => {
        const buf = getOrCreateBuffer(e.terminal);
        if (buf) {
          buf.name = e.terminal.name;
          writeToRingBuffer(buf, e.data);
        }
      });
      context.subscriptions.push(disposable);
      setOutputCaptureEnabled(true);
      bridge.log("Terminal output capture enabled");
    }
  } catch {
    bridge.log("Terminal output capture unavailable (proposed API not supported)");
  }

  // Initialize buffers for already-open terminals
  for (const terminal of vscode.window.terminals) {
    getOrCreateBuffer(terminal);
  }

  // Manual reconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeIdeBridge.reconnect", () => {
      if (bridge.ws) {
        bridge.ws.close();
        bridge.ws = null;
      }
      if (bridge.reconnectTimer) {
        clearTimeout(bridge.reconnectTimer);
        bridge.reconnectTimer = null;
      }
      bridge.tryConnect();
      vscode.window.showInformationMessage(
        "Claude IDE Bridge: Attempting to reconnect...",
      );
    }),
  );

  // Show Logs command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeIdeBridge.showLogs", () => {
      bridge.output?.show();
    }),
  );

  // Copy Connection Info command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeIdeBridge.copyConnectionInfo", () => {
      const info = [
        `State: ${bridge.ws?.readyState === WebSocket.OPEN ? "Connected" : "Disconnected"}`,
        `Extension version: 0.1.0`,
        `VS Code: ${vscode.version}`,
      ].join("\n");
      vscode.env.clipboard.writeText(info);
      vscode.window.showInformationMessage("Connection info copied to clipboard");
    }),
  );
}
