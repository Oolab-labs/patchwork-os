import * as vscode from "vscode";
import WebSocket from "ws";

import type { BridgeConnection } from "./connection";
import {
  AI_COMMENTS_DEBOUNCE,
  DIAGNOSTICS_DEBOUNCE,
  MAX_DIAGNOSTICS_PER_FILE,
  MAX_SELECTED_TEXT_BYTES,
  SELECTION_DEBOUNCE,
} from "./constants";
import {
  invalidateDocumentCache,
  scanAllOpenDocuments,
  scanDocumentForAIComments,
} from "./handlers/aiComments";
import { diagnosticToJson } from "./handlers/diagnostics";
import {
  deleteTerminalBuffer,
  getOrCreateBuffer,
  setOutputCaptureEnabled,
  writeToRingBuffer,
} from "./handlers/terminal";

export function registerEvents(
  context: vscode.ExtensionContext,
  getBridges: () => BridgeConnection[],
  output: vscode.OutputChannel,
): void {
  function notifyAll(
    method: string,
    params: Record<string, unknown>,
  ): void {
    for (const bridge of getBridges()) {
      bridge.sendNotification(method, params);
    }
  }

  function isAnyConnected(): boolean {
    // Check readyState === OPEN rather than ws !== null — a CLOSING socket is
    // non-null but can no longer send; broadcasting to it causes silent drops.
    return getBridges().some((b) => b.ws?.readyState === WebSocket.OPEN);
  }

  // Local debounce state (shared across all connections — one flush per event window)
  let diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingDiagnosticUris = new Set<string>();
  let selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let aiCommentsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Diagnostics changes (debounced, batched, broadcast to all connected bridges)
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      if (!isAnyConnected()) return;
      for (const uri of e.uris) {
        pendingDiagnosticUris.add(uri.toString());
      }
      if (diagnosticsDebounceTimer) clearTimeout(diagnosticsDebounceTimer);
      diagnosticsDebounceTimer = setTimeout(() => {
        for (const uriStr of pendingDiagnosticUris) {
          const uri = vscode.Uri.parse(uriStr);
          const diags = vscode.languages.getDiagnostics(uri);
          notifyAll("extension/diagnosticsChanged", {
            file: uri.fsPath,
            diagnostics: diags
              .slice(0, MAX_DIAGNOSTICS_PER_FILE)
              .map(diagnosticToJson),
          });
        }
        pendingDiagnosticUris.clear();
      }, DIAGNOSTICS_DEBOUNCE);
    }),
  );

  // Selection changes (debounced, broadcast)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isAnyConnected()) return;
      if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = setTimeout(() => {
        const sel = e.selections[0];
        if (!sel) return;
        let selectedText = e.textEditor.document.getText(sel);
        if (
          Buffer.byteLength(selectedText, "utf-8") > MAX_SELECTED_TEXT_BYTES
        ) {
          selectedText = Buffer.from(selectedText, "utf-8")
            .subarray(0, MAX_SELECTED_TEXT_BYTES)
            .toString("utf-8");
        }
        notifyAll("extension/selectionChanged", {
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
        notifyAll("extension/activeFileChanged", {
          file: editor.document.uri.fsPath,
        });
      }
    }),
  );

  // AI comment scanning (debounced)
  const pendingAICommentDocs = new Map<string, vscode.TextDocument>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isAnyConnected()) return;
      if (e.document.uri.scheme !== "file") return;
      pendingAICommentDocs.set(e.document.uri.toString(), e.document);
      if (aiCommentsDebounceTimer) clearTimeout(aiCommentsDebounceTimer);
      aiCommentsDebounceTimer = setTimeout(() => {
        for (const [uriStr, doc] of pendingAICommentDocs) {
          invalidateDocumentCache(uriStr);
          scanDocumentForAIComments(doc);
        }
        pendingAICommentDocs.clear();
        const allComments = scanAllOpenDocuments();
        notifyAll("extension/aiCommentsChanged", { comments: allComments });
      }, AI_COMMENTS_DEBOUNCE);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      const comments = scanDocumentForAIComments(doc);
      if (comments.length > 0) {
        if (aiCommentsDebounceTimer) clearTimeout(aiCommentsDebounceTimer);
        aiCommentsDebounceTimer = setTimeout(() => {
          const allComments = scanAllOpenDocuments();
          notifyAll("extension/aiCommentsChanged", { comments: allComments });
        }, AI_COMMENTS_DEBOUNCE);
      }
    }),
  );

  // File saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      notifyAll("extension/fileSaved", { file: doc.uri.fsPath });
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
    // biome-ignore lint/suspicious/noExplicitAny: proposed VS Code API not yet in type definitions
    const onDidWriteTerminalData = (vscode.window as any)
      .onDidWriteTerminalData;
    if (typeof onDidWriteTerminalData === "function") {
      const disposable = onDidWriteTerminalData(
        (e: { terminal: vscode.Terminal; data: string }) => {
          const buf = getOrCreateBuffer(e.terminal);
          if (buf) {
            buf.name = e.terminal.name;
            writeToRingBuffer(buf, e.data);
          }
        },
      );
      context.subscriptions.push(disposable);
      setOutputCaptureEnabled(true);
      output.appendLine(
        `${new Date().toISOString()} Terminal output capture enabled`,
      );
    }
  } catch {
    output.appendLine(
      `${new Date().toISOString()} Terminal output capture unavailable (proposed API not supported)`,
    );
  }

  // Initialize buffers for already-open terminals
  for (const terminal of vscode.window.terminals) {
    getOrCreateBuffer(terminal);
  }

  // Manual reconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeIdeBridge.reconnect", () => {
      for (const bridge of getBridges()) bridge.forceReconnect();
      vscode.window.showInformationMessage(
        "Claude IDE Bridge: Attempting to reconnect...",
      );
    }),
  );

  // Show Logs command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeIdeBridge.showLogs", () => {
      output.show();
    }),
  );

  // Copy Connection Info command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeIdeBridge.copyConnectionInfo",
      () => {
        const version =
          (context.extension?.packageJSON?.version as string) ?? "unknown";
        const bridges = getBridges();
        const connectedCount = bridges.filter(
          (b) => b.ws?.readyState === WebSocket.OPEN,
        ).length;
        const info = [
          `State: ${connectedCount}/${bridges.length} bridge(s) connected`,
          `Extension version: ${version}`,
          `VS Code: ${vscode.version}`,
        ].join("\n");
        vscode.env.clipboard.writeText(info);
        vscode.window.showInformationMessage(
          "Connection info copied to clipboard",
        );
      },
    ),
  );
}
