import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { handleGetSelection } from "../../handlers/selection";
import {
  Position,
  __reset,
  _mockTextDocument,
  _mockTextEditor,
} from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

describe("handleGetSelection", () => {
  it("returns null when no active editor", async () => {
    vscode.window.activeTextEditor = undefined;
    expect(await handleGetSelection()).toBeNull();
  });

  it("returns selection data for active editor", async () => {
    const doc = _mockTextDocument({
      fsPath: "/workspace/file.ts",
      getText: () => "selected text",
    });
    const editor = _mockTextEditor({
      document: doc,
      selection: {
        start: new Position(4, 2),
        end: new Position(4, 15),
      },
    });
    vscode.window.activeTextEditor = editor;

    const result = (await handleGetSelection()) as any;
    expect(result.file).toBe("/workspace/file.ts");
    expect(result.startLine).toBe(5); // 4 + 1
    expect(result.startColumn).toBe(3); // 2 + 1
    expect(result.endLine).toBe(5);
    expect(result.endColumn).toBe(16); // 15 + 1
    expect(result.selectedText).toBe("selected text");
  });
});
