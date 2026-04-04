import * as vscode from "vscode";
import type { BridgeConnection } from "./connection";

const LSP_READINESS_TIMEOUT_MS = 30_000;

/**
 * Tracks which language servers have finished indexing by observing
 * `onDidChangeDiagnostics`. When diagnostics first appear for a language ID,
 * that language is marked as "ready" and a notification is sent to the bridge.
 *
 * If no diagnostics arrive within 30 seconds, the tracker assumes all relevant
 * language servers are ready (covers projects with no errors).
 */
export function createLspReadinessTracker(
  getBridge: () => BridgeConnection,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const readyLanguages = new Set<string>();
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const disposables: vscode.Disposable[] = [];

  function sendReady(languageId: string): void {
    if (readyLanguages.has(languageId)) return;
    readyLanguages.add(languageId);
    output.appendLine(`${new Date().toISOString()} LSP ready: ${languageId}`);
    getBridge().sendNotification("extension/lspReady", {
      languageId,
      timestamp: Date.now(),
    });
  }

  /** Re-send readiness for all known-ready languages (after reconnect). */
  function resendAll(): void {
    for (const lang of readyLanguages) {
      getBridge().sendNotification("extension/lspReady", {
        languageId: lang,
        timestamp: Date.now(),
      });
    }
  }

  // Listen for diagnostic changes — first diagnostic per language = ready
  disposables.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString(),
        );
        if (!doc) continue;
        const langId = doc.languageId;
        if (langId && !readyLanguages.has(langId)) {
          // Only mark ready if there are actual diagnostics (not just a clear event)
          const diags = vscode.languages.getDiagnostics(uri);
          if (diags.length > 0) {
            sendReady(langId);
          }
        }
      }
    }),
  );

  // Fallback: after 30s, mark all open document languages as ready
  function startFallbackTimer(): void {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === "file" && !readyLanguages.has(doc.languageId)) {
          sendReady(doc.languageId);
        }
      }
    }, LSP_READINESS_TIMEOUT_MS);
  }

  startFallbackTimer();

  return {
    dispose(): void {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      for (const d of disposables) d.dispose();
    },
    // Expose for reconnect — extension.ts calls this
    resendAll,
    startFallbackTimer,
  } as vscode.Disposable & {
    resendAll: () => void;
    startFallbackTimer: () => void;
  };
}
