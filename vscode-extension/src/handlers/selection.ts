import * as vscode from "vscode";

export async function handleGetSelection(): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const sel = editor.selection;
  return {
    file: editor.document.uri.fsPath,
    startLine: sel.start.line + 1,
    startColumn: sel.start.character + 1,
    endLine: sel.end.line + 1,
    endColumn: sel.end.character + 1,
    selectedText: editor.document.getText(sel),
  };
}
