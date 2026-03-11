import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { __reset, _mockTextDocument } from "../__mocks__/vscode";
import { handleEditText } from "../../handlers/editText";

beforeEach(() => {
  __reset();
});

describe("handleEditText", () => {
  it("applies an insert edit", async () => {
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "insert", line: 1, column: 1, text: "hello" }],
    })) as any;
    expect(result.success).toBe(true);
    expect(result.editCount).toBe(1);
    expect(vscode.workspace.applyEdit).toHaveBeenCalled();
  });

  it("applies a delete edit", async () => {
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "delete", line: 1, column: 1, endLine: 1, endColumn: 5 }],
    })) as any;
    expect(result.success).toBe(true);
  });

  it("applies a replace edit", async () => {
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "replace", line: 1, column: 1, endLine: 1, endColumn: 5, text: "new" }],
    })) as any;
    expect(result.success).toBe(true);
  });

  it("applies multiple edits", async () => {
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [
        { type: "insert", line: 1, column: 1, text: "a" },
        { type: "insert", line: 2, column: 1, text: "b" },
        { type: "delete", line: 3, column: 1, endLine: 3, endColumn: 5 },
      ],
    })) as any;
    expect(result.editCount).toBe(3);
  });

  it("throws when edits is not an array", async () => {
    await expect(handleEditText({ filePath: "/workspace/test.ts", edits: "bad" })).rejects.toThrow("must be an array");
  });

  it("throws when edits exceed 1000", async () => {
    const edits = Array.from({ length: 1001 }, () => ({ type: "insert", line: 1, column: 1, text: "x" }));
    await expect(handleEditText({ filePath: "/workspace/test.ts", edits })).rejects.toThrow("Maximum 1000");
  });

  it("throws on unknown edit type", async () => {
    await expect(
      handleEditText({ filePath: "/workspace/test.ts", edits: [{ type: "unknown", line: 1, column: 1 }] }),
    ).rejects.toThrow("Unknown edit type");
  });

  it("throws when edit is not an object", async () => {
    await expect(handleEditText({ filePath: "/workspace/test.ts", edits: ["bad"] })).rejects.toThrow("must be an object");
  });

  it("returns error when applyEdit fails", async () => {
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false);
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "insert", line: 1, column: 1, text: "x" }],
    })) as any;
    expect(result.success).toBe(false);
  });

  it("saves document when save=true", async () => {
    const save = vi.fn(async () => true);
    const doc = _mockTextDocument({ fsPath: "/workspace/test.ts", save });
    vscode.workspace.textDocuments = [doc];

    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "insert", line: 1, column: 1, text: "x" }],
      save: true,
    })) as any;
    expect(result.saved).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it("does not save when save is not set", async () => {
    const result = (await handleEditText({
      filePath: "/workspace/test.ts",
      edits: [{ type: "insert", line: 1, column: 1, text: "x" }],
    })) as any;
    expect(result.saved).toBe(false);
  });

  it("throws on missing filePath", async () => {
    await expect(handleEditText({ edits: [] } as any)).rejects.toThrow("must be a non-empty string");
  });
});
