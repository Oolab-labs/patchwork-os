import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { requireString } from "./validation";

export function assertWithinWorkspace(filePath: string): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // Fail closed: no workspace open means no basis for containment — reject all file ops
    throw new Error(
      "No workspace is open — file operations require an open workspace folder",
    );
  }
  const resolved = path.resolve(filePath);
  // Resolve symlinks if path exists — prevents symlink escape attacks
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist yet (e.g., createFile) — resolve symlinks on the parent
    // directory instead to prevent TOCTOU symlink escape attacks (BUG-22).
    const parent = path.dirname(resolved);
    const filename = path.basename(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      realPath = path.join(realParent, filename);
    } catch {
      // Parent also doesn't exist — fall back to resolved path
      realPath = resolved;
    }
  }
  const inWorkspace = folders.some((f) => {
    const wsRoot = f.uri.fsPath;
    return realPath === wsRoot || realPath.startsWith(wsRoot + path.sep);
  });
  if (!inWorkspace) {
    throw new Error(`Path "${filePath}" is outside the workspace`);
  }
}

export async function handleGetOpenFiles(): Promise<unknown> {
  const tabs: Array<{
    filePath: string;
    isActive: boolean;
    isDirty: boolean;
  }> = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const tabUri = tab.input.uri;
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === tabUri.toString(),
        );
        tabs.push({
          filePath: tabUri.fsPath,
          isActive: tab.isActive,
          isDirty: tab.isDirty,
          ...(doc ? { languageId: doc.languageId } : {}),
        });
      }
    }
  }
  return tabs;
}

export async function handleIsDirty(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireString(params.file, "file");
  assertWithinWorkspace(file);
  const uri = vscode.Uri.file(file);
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath === uri.fsPath) {
      return doc.isDirty;
    }
  }
  return false;
}

export async function handleOpenFile(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireString(params.file, "file");
  assertWithinWorkspace(file);
  const line =
    typeof params.line === "number" && Number.isInteger(params.line)
      ? params.line
      : 1;
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const position = new vscode.Position(Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(position, position),
    preview: false,
  });
  return true;
}

export async function handleSaveFile(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireString(params.file, "file");
  assertWithinWorkspace(file);
  const uri = vscode.Uri.file(file);
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath === uri.fsPath) {
      if (doc.isUntitled) {
        return { success: false, error: "Cannot save untitled document" };
      }
      await doc.save();
      return true;
    }
  }
  return { success: false, error: "Document not open" };
}

export async function handleCloseTab(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireString(params.file, "file");
  assertWithinWorkspace(file);
  const uri = vscode.Uri.file(file);
  // Normalize the target path: resolve symlinks when the file exists so our
  // comparison matches what VS Code stores in tab.input.uri.fsPath, which may
  // also be a real (symlink-resolved) path on some platforms.
  let normalizedTarget: string;
  try {
    normalizedTarget = fs.realpathSync(uri.fsPath);
  } catch {
    normalizedTarget = path.resolve(uri.fsPath);
  }

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const tabFsPath = tab.input.uri.fsPath;
        // Normalize the tab path the same way so symlink differences don't
        // cause a mismatch (e.g. /private/var vs /var on macOS, or SSH remote
        // paths where the workspace root is a symlink).
        let normalizedTab: string;
        try {
          normalizedTab = fs.realpathSync(tabFsPath);
        } catch {
          normalizedTab = path.resolve(tabFsPath);
        }
        if (normalizedTab === normalizedTarget) {
          const result = await vscode.window.tabGroups.close(tab);
          return { success: result, promptedToSave: tab.isDirty };
        }
      }
    }
  }
  return { success: false, error: "Tab not found" };
}

export async function handleGetFileContent(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = requireString(params.file, "file");
  assertWithinWorkspace(file);
  const uri = vscode.Uri.file(file);

  // Prefer in-memory document — it may have unsaved edits
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath === uri.fsPath) {
      return {
        content: doc.getText(),
        isDirty: doc.isDirty,
        languageId: doc.languageId,
        lineCount: doc.lineCount,
        version: doc.version,
        source: "vscode-buffer",
      };
    }
  }

  // File not open — load silently (no visual side-effect, content matches disk)
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return {
      content: doc.getText(),
      isDirty: false,
      languageId: doc.languageId,
      lineCount: doc.lineCount,
      version: doc.version,
      source: "vscode-disk",
    };
  } catch (err) {
    return {
      success: false,
      error: `Cannot open file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// === File Operations (create, delete, rename) ===

export async function handleCreateFile(
  params: Record<string, unknown>,
): Promise<unknown> {
  const filePath = requireString(params.filePath, "filePath");
  assertWithinWorkspace(filePath);
  const content = (params.content as string) ?? "";
  const isDirectory = (params.isDirectory as boolean) ?? false;
  const overwrite = (params.overwrite as boolean) ?? false;
  const openAfterCreate = (params.openAfterCreate as boolean) ?? true;

  const uri = vscode.Uri.file(filePath);

  if (isDirectory) {
    await vscode.workspace.fs.createDirectory(uri);
    return { success: true, filePath, isDirectory: true, created: true };
  }

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.createFile(uri, {
    overwrite,
    contents: Buffer.from(content, "utf-8"),
  });
  const applied = await vscode.workspace.applyEdit(wsEdit);

  if (!applied) {
    return { success: false, error: "Failed to create file" };
  }

  if (openAfterCreate) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  return { success: true, filePath, isDirectory: false, created: true };
}

export async function handleDeleteFile(
  params: Record<string, unknown>,
): Promise<unknown> {
  const filePath = requireString(params.filePath, "filePath");
  assertWithinWorkspace(filePath);
  const recursive = (params.recursive as boolean) ?? false;
  const useTrash = (params.useTrash as boolean) ?? true;

  const uri = vscode.Uri.file(filePath);

  try {
    await vscode.workspace.fs.delete(uri, { recursive, useTrash });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to delete: ${message}` };
  }
  return { success: true, filePath, deleted: true };
}

export async function handleRenameFile(
  params: Record<string, unknown>,
): Promise<unknown> {
  const oldPath = requireString(params.oldPath, "oldPath");
  const newPath = requireString(params.newPath, "newPath");
  assertWithinWorkspace(oldPath);
  assertWithinWorkspace(newPath);
  const overwrite = (params.overwrite as boolean) ?? false;

  const oldUri = vscode.Uri.file(oldPath);
  const newUri = vscode.Uri.file(newPath);

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.renameFile(oldUri, newUri, { overwrite });
  const applied = await vscode.workspace.applyEdit(wsEdit);

  if (!applied) {
    return { success: false, error: "Failed to rename file" };
  }

  return { success: true, oldPath, newPath, renamed: true };
}

export async function handleGetWorkspaceFolders(): Promise<unknown> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { folders: [], count: 0 };
  }
  return {
    folders: folders.map((f) => ({
      name: f.name,
      path: f.uri.fsPath,
      uri: f.uri.toString(),
      index: f.index,
    })),
    count: folders.length,
  };
}
