import * as vscode from "vscode";
import { MAX_SELECTED_TEXT_BYTES } from "../constants";

export async function handleGetSelection(): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { error: "No active editor" };
  const sel = editor.selection;
  let selectedText = editor.document.getText(sel);
  // Cap selectedText so Ctrl+A on a huge file can't push a multi-MB payload
  // over the WebSocket. Mirrors the push path in events.ts.
  if (Buffer.byteLength(selectedText, "utf-8") > MAX_SELECTED_TEXT_BYTES) {
    selectedText = Buffer.from(selectedText, "utf-8")
      .subarray(0, MAX_SELECTED_TEXT_BYTES)
      .toString("utf-8");
  }
  return {
    file: editor.document.uri.fsPath,
    startLine: sel.start.line + 1,
    startColumn: sel.start.character + 1,
    endLine: sel.end.line + 1,
    endColumn: sel.end.character + 1,
    selectedText,
  };
}
