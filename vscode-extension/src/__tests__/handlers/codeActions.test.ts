import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleFixAllLintErrors,
  handleFormatDocument,
  handleOrganizeImports,
} from "../../handlers/codeActions";
import {
  __reset,
  _mockTextDocument,
  _mockTextEditor,
} from "../__mocks__/vscode";

function setupEditorMock() {
  const save = vi.fn(async () => true);
  const doc = _mockTextDocument({
    fsPath: "/workspace/file.ts",
    lineCount: 20,
    save,
  });
  const editor = _mockTextEditor({ document: doc });
  vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(doc);
  vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor as any);
  return { doc, editor, save };
}

beforeEach(() => {
  __reset();
});

describe("handleFormatDocument", () => {
  it("applies formatting edits and saves", async () => {
    const { save } = setupEditorMock();
    const textEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      newText: "const",
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([textEdit]);

    const result = (await handleFormatDocument({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.editsApplied).toBe(1);
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it("saves even with no edits", async () => {
    const { save } = setupEditorMock();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);

    const result = (await handleFormatDocument({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.editsApplied).toBe(0);
    expect(save).toHaveBeenCalled();
  });

  it("throws on missing file param", async () => {
    await expect(handleFormatDocument({} as any)).rejects.toThrow();
  });
});

describe("handleFixAllLintErrors", () => {
  it("applies code actions with edits", async () => {
    const { save } = setupEditorMock();
    const wsEdit = new vscode.WorkspaceEdit();
    const action = { edit: wsEdit, command: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await handleFixAllLintErrors({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.actionsApplied).toBe(1);
    expect(save).toHaveBeenCalled();
  });

  it("executes code action commands", async () => {
    setupEditorMock();
    const action = {
      edit: undefined,
      command: { command: "eslint.fix", arguments: [] },
    };
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([action]) // code action provider
      .mockResolvedValueOnce(undefined); // execute command

    const result = (await handleFixAllLintErrors({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.actionsApplied).toBe(1);
  });

  it("handles no actions available", async () => {
    setupEditorMock();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);

    const result = (await handleFixAllLintErrors({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.actionsApplied).toBe(0);
  });
});

describe("handleOrganizeImports", () => {
  it("applies organize imports action", async () => {
    const { save } = setupEditorMock();
    const wsEdit = new vscode.WorkspaceEdit();
    const action = { edit: wsEdit, command: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await handleOrganizeImports({
      file: "/workspace/file.ts",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.actionsApplied).toBe(1);
    expect(save).toHaveBeenCalled();
  });
});
