import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleCloseTab,
  handleCreateFile,
  handleDeleteFile,
  handleGetOpenFiles,
  handleIsDirty,
  handleOpenFile,
  handleRenameFile,
  handleSaveFile,
} from "../../handlers/files";
import {
  __reset,
  _mockTextDocument,
  TabInputText,
  Uri,
} from "../__mocks__/vscode";

const WORKSPACE = path.resolve("/workspace");
const OTHER_ROOT = path.resolve("/other");
const ANYWHERE = path.resolve("/anywhere");
const wsFile = (...parts: string[]) => path.join(WORKSPACE, ...parts);
const otherFile = (...parts: string[]) => path.join(OTHER_ROOT, ...parts);

beforeEach(() => {
  __reset();
});

// ── Workspace boundary (tested through handlers) ──────────────

describe("workspace boundary checks", () => {
  it("rejects all paths when no workspace folders", async () => {
    vscode.workspace.workspaceFolders = undefined;
    await expect(
      handleOpenFile({ file: path.join(ANYWHERE, "file.ts") }),
    ).rejects.toThrow("No workspace is open");
  });

  it("allows paths inside workspace", async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }] as any;
    await expect(
      handleOpenFile({ file: wsFile("src", "file.ts") }),
    ).resolves.not.toThrow();
  });

  it("allows exact workspace root", async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }] as any;
    await expect(handleIsDirty({ file: WORKSPACE })).resolves.not.toThrow();
  });

  it("rejects paths outside workspace", async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }] as any;
    await expect(
      handleOpenFile({ file: otherFile("file.ts") }),
    ).rejects.toThrow("outside the workspace");
  });
});

// ── handleGetOpenFiles ────────────────────────────────────────

describe("handleGetOpenFiles", () => {
  it("returns empty array when no tabs", async () => {
    vscode.window.tabGroups.all = [];
    expect(await handleGetOpenFiles()).toEqual([]);
  });

  it("returns file info for TabInputText tabs", async () => {
    const fileA = wsFile("test.ts");
    const fileB = wsFile("other.ts");
    const uri = Uri.file(fileA);
    vscode.window.tabGroups.all = [
      {
        tabs: [
          { input: new TabInputText(uri), isActive: true, isDirty: false },
          {
            input: new TabInputText(Uri.file(fileB)),
            isActive: false,
            isDirty: true,
          },
        ],
      },
    ] as any;

    const result = (await handleGetOpenFiles()) as any[];
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      filePath: fileA,
      isActive: true,
      isDirty: false,
    });
    expect(result[1]).toEqual({
      filePath: fileB,
      isActive: false,
      isDirty: true,
    });
  });

  it("skips non-TabInputText tabs", async () => {
    vscode.window.tabGroups.all = [
      {
        tabs: [
          {
            input: { notATabInputText: true },
            isActive: false,
            isDirty: false,
          },
        ],
      },
    ] as any;
    expect(await handleGetOpenFiles()).toEqual([]);
  });
});

// ── handleIsDirty ─────────────────────────────────────────────

describe("handleIsDirty", () => {
  it("throws on non-string file param", async () => {
    await expect(handleIsDirty({ file: 123 } as any)).rejects.toThrow(
      "must be a non-empty string",
    );
  });

  it("returns true for dirty document", async () => {
    const doc = _mockTextDocument({ fsPath: wsFile("f.ts"), isDirty: true });
    vscode.workspace.textDocuments = [doc];
    expect(await handleIsDirty({ file: wsFile("f.ts") })).toBe(true);
  });

  it("returns false for clean document", async () => {
    const doc = _mockTextDocument({
      fsPath: wsFile("f.ts"),
      isDirty: false,
    });
    vscode.workspace.textDocuments = [doc];
    expect(await handleIsDirty({ file: wsFile("f.ts") })).toBe(false);
  });

  it("returns false when document not found", async () => {
    vscode.workspace.textDocuments = [];
    expect(await handleIsDirty({ file: wsFile("missing.ts") })).toBe(false);
  });
});

// ── handleOpenFile ────────────────────────────────────────────

describe("handleOpenFile", () => {
  it("opens document and shows with position", async () => {
    const doc = _mockTextDocument({ fsPath: wsFile("f.ts") });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(doc);

    const result = await handleOpenFile({ file: wsFile("f.ts"), line: 10 });
    expect(result).toBe(true);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      doc,
      expect.objectContaining({ preview: false }),
    );
  });

  it("defaults to line 1", async () => {
    const doc = _mockTextDocument({ fsPath: wsFile("f.ts") });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(doc);
    await handleOpenFile({ file: wsFile("f.ts") });
    // Position should be (0, 0) since line defaults to 1, converted to 0-based
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });
});

// ── handleSaveFile ────────────────────────────────────────────

describe("handleSaveFile", () => {
  it("saves an open document", async () => {
    const save = vi.fn(async () => true);
    const doc = _mockTextDocument({ fsPath: wsFile("f.ts"), save });
    vscode.workspace.textDocuments = [doc];
    expect(await handleSaveFile({ file: wsFile("f.ts") })).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it("returns error for untitled document", async () => {
    const doc = _mockTextDocument({
      fsPath: wsFile("f.ts"),
      isUntitled: true,
    });
    vscode.workspace.textDocuments = [doc];
    const result = (await handleSaveFile({ file: wsFile("f.ts") })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("untitled");
  });

  it("returns error when document not open", async () => {
    vscode.workspace.textDocuments = [];
    const result = (await handleSaveFile({ file: wsFile("f.ts") })) as any;
    expect(result.success).toBe(false);
  });
});

// ── handleCloseTab ────────────────────────────────────────────

describe("handleCloseTab", () => {
  it("closes a matching tab", async () => {
    const uri = Uri.file(wsFile("f.ts"));
    const tab = {
      input: new TabInputText(uri),
      isActive: true,
      isDirty: false,
    };
    vscode.window.tabGroups.all = [{ tabs: [tab] }] as any;
    vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(true);

    const result = (await handleCloseTab({ file: wsFile("f.ts") })) as any;
    expect(result.success).toBe(true);
    expect(result.promptedToSave).toBe(false);
  });

  it("returns error when tab not found", async () => {
    vscode.window.tabGroups.all = [];
    const result = (await handleCloseTab({ file: wsFile("f.ts") })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ── handleCreateFile ──────────────────────────────────────────

describe("handleCreateFile", () => {
  it("creates a file and opens it", async () => {
    const result = (await handleCreateFile({
      filePath: wsFile("new.ts"),
      content: "hello",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.isDirectory).toBe(false);
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });

  it("creates a directory", async () => {
    const result = (await handleCreateFile({
      filePath: wsFile("dir"),
      isDirectory: true,
    })) as any;
    expect(result.success).toBe(true);
    expect(result.isDirectory).toBe(true);
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalled();
  });

  it("skips opening when openAfterCreate=false", async () => {
    await handleCreateFile({
      filePath: wsFile("new.ts"),
      openAfterCreate: false,
    });
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("returns error when applyEdit fails", async () => {
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false);
    const result = (await handleCreateFile({
      filePath: wsFile("new.ts"),
    })) as any;
    expect(result.success).toBe(false);
  });
});

// ── handleDeleteFile ──────────────────────────────────────────

describe("handleDeleteFile", () => {
  it("deletes a file with defaults", async () => {
    const result = (await handleDeleteFile({
      filePath: wsFile("f.ts"),
    })) as any;
    expect(result.success).toBe(true);
    expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: wsFile("f.ts") }),
      { recursive: false, useTrash: true },
    );
  });

  it("returns error on delete failure", async () => {
    vi.mocked(vscode.workspace.fs.delete).mockRejectedValue(
      new Error("ENOENT"),
    );
    const result = (await handleDeleteFile({
      filePath: wsFile("f.ts"),
    })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("ENOENT");
  });
});

// ── handleRenameFile ──────────────────────────────────────────

describe("handleRenameFile", () => {
  it("renames a file", async () => {
    const result = (await handleRenameFile({
      oldPath: wsFile("a.ts"),
      newPath: wsFile("b.ts"),
    })) as any;
    expect(result.success).toBe(true);
    expect(result.renamed).toBe(true);
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  it("returns error when applyEdit fails", async () => {
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false);
    const result = (await handleRenameFile({
      oldPath: wsFile("a.ts"),
      newPath: wsFile("b.ts"),
    })) as any;
    expect(result.success).toBe(false);
  });

  it("checks both paths against workspace", async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }] as any;
    await expect(
      handleRenameFile({
        oldPath: wsFile("a.ts"),
        newPath: otherFile("b.ts"),
      }),
    ).rejects.toThrow("outside the workspace");
  });
});
