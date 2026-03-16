import * as vscode from "vscode";
import { assertWithinWorkspace } from "./files";

function requireFile(params: Record<string, unknown>): string {
  const file = params.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(
      "file parameter is required and must be a non-empty string",
    );
  }
  return file;
}

async function openAndShowDocument(file: string): Promise<vscode.TextEditor> {
  assertWithinWorkspace(file);
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

export async function handleFormatDocument(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireFile(params);
  const editor = await openAndShowDocument(file);

  let edits: vscode.TextEdit[] | undefined;
  try {
    edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      editor.document.uri,
      {
        tabSize: editor.options.tabSize,
        insertSpaces: editor.options.insertSpaces,
      },
    );
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "Command failed",
    };
  }

  if (edits && edits.length > 0) {
    const wsEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      wsEdit.replace(editor.document.uri, edit.range, edit.newText);
    }
    await vscode.workspace.applyEdit(wsEdit);
  }

  await editor.document.save();
  return { success: true, editsApplied: edits?.length ?? 0 };
}

export async function handleFixAllLintErrors(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireFile(params);
  const editor = await openAndShowDocument(file);

  // Try source.fixAll code action
  const range = new vscode.Range(0, 0, editor.document.lineCount, 0);
  let actions: vscode.CodeAction[] | undefined;
  try {
    actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      editor.document.uri,
      range,
      vscode.CodeActionKind.SourceFixAll.value,
    );
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "Command failed",
    };
  }

  let appliedCount = 0;
  if (actions && actions.length > 0) {
    for (const action of actions) {
      if (action.edit) {
        const applied = await vscode.workspace.applyEdit(action.edit);
        if (applied) appliedCount++;
      }
      if (action.command) {
        try {
          await vscode.commands.executeCommand(
            action.command.command,
            ...(action.command.arguments ?? []),
          );
        } catch (err: unknown) {
          return {
            error: err instanceof Error ? err.message : "Command failed",
          };
        }
        appliedCount++;
      }
    }
  }

  await editor.document.save();
  return { success: true, actionsApplied: appliedCount };
}

export async function handleOrganizeImports(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireFile(params);
  const editor = await openAndShowDocument(file);

  // Use the organize imports code action
  const range = new vscode.Range(0, 0, editor.document.lineCount, 0);
  let actions: vscode.CodeAction[] | undefined;
  try {
    actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      editor.document.uri,
      range,
      vscode.CodeActionKind.SourceOrganizeImports.value,
    );
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "Command failed",
    };
  }

  let appliedCount = 0;
  if (actions && actions.length > 0) {
    for (const action of actions) {
      if (action.edit) {
        const applied = await vscode.workspace.applyEdit(action.edit);
        if (applied) appliedCount++;
      }
      if (action.command) {
        try {
          await vscode.commands.executeCommand(
            action.command.command,
            ...(action.command.arguments ?? []),
          );
        } catch (err: unknown) {
          return {
            error: err instanceof Error ? err.message : "Command failed",
          };
        }
        appliedCount++;
      }
    }
  }

  await editor.document.save();
  return { success: true, actionsApplied: appliedCount };
}
