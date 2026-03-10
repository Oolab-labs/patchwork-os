import * as vscode from "vscode";
import type { RequestHandler } from "../types";

interface DecorationEntry {
  type: vscode.TextEditorDecorationType;
  style: string;
  fileRanges: Map<string, vscode.DecorationOptions[]>;
}

const STYLE_MAP: Record<string, vscode.DecorationRenderOptions> = {
  info: {
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  },
  warning: {
    backgroundColor: new vscode.ThemeColor("diffEditor.modifiedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  },
  error: {
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  },
  focus: {
    border: "1px solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  },
  strikethrough: {
    textDecoration: "line-through",
    opacity: "0.6",
  },
  dim: {
    opacity: "0.4",
  },
};

export function createDecorationHandlers(): {
  handlers: Record<string, RequestHandler>;
  disposeAll: () => void;
} {
  const activeDecorations = new Map<string, DecorationEntry>();
  const disposables: vscode.Disposable[] = [];

  function applyToEditor(editor: vscode.TextEditor, entry: DecorationEntry): void {
    const fileRangesForEditor = entry.fileRanges.get(editor.document.uri.fsPath);
    if (fileRangesForEditor) {
      editor.setDecorations(entry.type, fileRangesForEditor);
    }
  }

  // Re-apply decorations when editors become visible
  disposables.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        for (const entry of activeDecorations.values()) {
          applyToEditor(editor, entry);
        }
      }
    }),
  );

  const handleSetDecorations: RequestHandler = async (params) => {
    const id = params.id;
    const file = params.file;
    if (typeof id !== "string" || id.length === 0) throw new Error("id is required");
    if (typeof file !== "string") throw new Error("file is required");
    if (!/^[\w\-]+$/.test(id)) throw new Error("id must be alphanumeric with hyphens/underscores only");

    const specs = Array.isArray(params.decorations) ? params.decorations : [];

    // Get or create the decoration type for this ID
    const requestedStyle = typeof (specs[0] as Record<string, unknown> | undefined)?.style === "string"
      ? (specs[0] as Record<string, unknown>).style as string
      : "info";
    let entry = activeDecorations.get(id);
    if (entry && entry.style !== requestedStyle) {
      // Style changed — dispose old type and recreate
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(entry.type, []);
      }
      entry.type.dispose();
      entry = undefined;
    }
    if (!entry) {
      const renderOptions = STYLE_MAP[requestedStyle] ?? STYLE_MAP.info;
      const type = vscode.window.createTextEditorDecorationType(renderOptions);
      entry = { type, style: requestedStyle, fileRanges: new Map() };
      activeDecorations.set(id, entry);
    }

    const decorationOptions: vscode.DecorationOptions[] = specs.map((spec: Record<string, unknown>) => {
      const startLine = typeof spec.startLine === "number" ? Math.max(0, spec.startLine - 1) : 0;
      const endLine = typeof spec.endLine === "number" ? Math.max(0, spec.endLine - 1) : startLine;
      const range = new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
      const result: vscode.DecorationOptions = { range };
      if (typeof spec.hoverMessage === "string") {
        result.hoverMessage = spec.hoverMessage;
      }
      if (typeof spec.message === "string") {
        result.renderOptions = {
          after: {
            contentText: `  ${spec.message}`,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
          },
        };
      }
      return result;
    });

    entry.fileRanges.set(file, decorationOptions);

    // Apply to any currently visible editors for this file
    let applied = 0;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === file) {
        editor.setDecorations(entry.type, decorationOptions);
        applied++;
      }
    }

    return { applied: specs.length, editorsUpdated: applied };
  };

  const handleClearDecorations: RequestHandler = async (params) => {
    const id = typeof params.id === "string" ? params.id : undefined;

    if (id) {
      const entry = activeDecorations.get(id);
      if (entry) {
        // Clear from all visible editors
        for (const editor of vscode.window.visibleTextEditors) {
          editor.setDecorations(entry.type, []);
        }
        entry.type.dispose();
        activeDecorations.delete(id);
        return { cleared: 1 };
      }
      return { cleared: 0 };
    }

    // Clear all
    const count = activeDecorations.size;
    for (const entry of activeDecorations.values()) {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(entry.type, []);
      }
      entry.type.dispose();
    }
    activeDecorations.clear();
    return { cleared: count };
  };

  return {
    handlers: {
      "extension/setDecorations": handleSetDecorations,
      "extension/clearDecorations": handleClearDecorations,
    },
    disposeAll() {
      for (const entry of activeDecorations.values()) {
        entry.type.dispose();
      }
      activeDecorations.clear();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
