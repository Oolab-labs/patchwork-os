import * as vscode from "vscode";
import { assertWithinWorkspace } from "./files";
import { requireNumber, requireString } from "./validation";

export async function handleEditText(
  params: Record<string, unknown>,
): Promise<unknown> {
  const filePath = requireString(params.filePath, "filePath");
  assertWithinWorkspace(filePath);
  const edits = params.edits;
  if (!Array.isArray(edits)) {
    throw new Error("edits must be an array");
  }
  if (edits.length > 1000) {
    throw new Error("Maximum 1000 edits per call");
  }
  const save = (params.save as boolean) ?? false;

  const uri = vscode.Uri.file(filePath);
  const wsEdit = new vscode.WorkspaceEdit();

  for (const edit of edits) {
    if (typeof edit !== "object" || edit === null) {
      throw new Error("Each edit must be an object");
    }
    const e = edit as Record<string, unknown>;
    const type = requireString(e.type, "edit.type");
    // Convert from 1-based to 0-based
    const line = requireNumber(e.line, "edit.line") - 1;
    const column = requireNumber(e.column, "edit.column") - 1;

    switch (type) {
      case "insert": {
        const text = requireString(e.text, "edit.text");
        const position = new vscode.Position(line, column);
        wsEdit.insert(uri, position, text);
        break;
      }
      case "delete": {
        const endLine = requireNumber(e.endLine, "edit.endLine") - 1;
        const endColumn = requireNumber(e.endColumn, "edit.endColumn") - 1;
        const range = new vscode.Range(line, column, endLine, endColumn);
        wsEdit.delete(uri, range);
        break;
      }
      case "replace": {
        const text = requireString(e.text, "edit.text");
        const endLine = requireNumber(e.endLine, "edit.endLine") - 1;
        const endColumn = requireNumber(e.endColumn, "edit.endColumn") - 1;
        const range = new vscode.Range(line, column, endLine, endColumn);
        wsEdit.replace(uri, range, text);
        break;
      }
      default:
        throw new Error(`Unknown edit type: ${type}`);
    }
  }

  const applied = await vscode.workspace.applyEdit(wsEdit);

  if (!applied) {
    return { success: false, error: "Failed to apply edits" };
  }

  let saved = false;
  if (save) {
    // Find and save the document
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.fsPath === uri.fsPath) {
        await doc.save();
        saved = true;
        break;
      }
    }
  }

  return { success: true, editCount: edits.length, saved };
}

export async function handleReplaceBlock(
  params: Record<string, unknown>,
): Promise<unknown> {
  const filePath = requireString(params.filePath, "filePath");
  assertWithinWorkspace(filePath);
  const oldContent = requireString(params.oldContent, "oldContent");
  const newContent = requireString(params.newContent, "newContent");
  const save = (params.save as boolean) ?? true;

  const uri = vscode.Uri.file(filePath);

  // Get current buffer text (captures unsaved edits)
  let doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === uri.fsPath,
  );
  if (!doc) {
    doc = await vscode.workspace.openTextDocument(uri);
  }
  const text = doc.getText();

  // Count matches — must be exactly one
  const firstIndex = text.indexOf(oldContent);
  if (firstIndex === -1) {
    return {
      success: false,
      error:
        "oldContent not found in file — verify the exact text including whitespace and line endings",
    };
  }
  const secondIndex = text.indexOf(oldContent, firstIndex + 1);
  if (secondIndex !== -1) {
    // Count total occurrences for a helpful message
    let count = 2;
    let idx = secondIndex;
    while ((idx = text.indexOf(oldContent, idx + 1)) !== -1) count++;
    return {
      success: false,
      error: `oldContent matches ${count} locations — add more surrounding context to make it unique`,
    };
  }

  // Convert offset to VS Code Position
  const before = text.slice(0, firstIndex);
  const startLines = before.split("\n");
  const startLine = startLines.length - 1;
  const startChar = startLines[startLines.length - 1]?.length ?? 0;

  const matched = text.slice(firstIndex, firstIndex + oldContent.length);
  const matchedLines = matched.split("\n");
  const endLine = startLine + matchedLines.length - 1;
  const endChar =
    matchedLines.length === 1
      ? startChar + (matchedLines[0]?.length ?? 0)
      : (matchedLines[matchedLines.length - 1]?.length ?? 0);

  const range = new vscode.Range(startLine, startChar, endLine, endChar);
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.replace(uri, range, newContent);

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return { success: false, error: "VS Code failed to apply the replacement" };
  }

  let saved = false;
  if (save) {
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.fsPath === uri.fsPath) {
        await d.save();
        saved = true;
        break;
      }
    }
  }

  return { success: true, saved, source: "vscode-buffer" };
}
