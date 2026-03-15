import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type TextEdit, applyEditsToContent } from "../editText.js";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createRenameFileTool,
} from "../fileOperations.js";

// ── applyEditsToContent (pure function, no I/O) ──────────────────────────

describe("applyEditsToContent", () => {
  it("inserts text at a position", () => {
    // column 7 = after the space in "hello world"
    const result = applyEditsToContent("hello world", [
      { type: "insert", line: 1, column: 7, text: "beautiful " },
    ]);
    expect(result).toBe("hello beautiful world");
  });

  it("inserts text at the beginning", () => {
    const result = applyEditsToContent("world", [
      { type: "insert", line: 1, column: 1, text: "hello " },
    ]);
    expect(result).toBe("hello world");
  });

  it("inserts text at the end of a line", () => {
    const result = applyEditsToContent("hello", [
      { type: "insert", line: 1, column: 6, text: " world" },
    ]);
    expect(result).toBe("hello world");
  });

  it("inserts multi-line text", () => {
    const result = applyEditsToContent("line1\nline3", [
      { type: "insert", line: 1, column: 6, text: "\nline2" },
    ]);
    expect(result).toBe("line1\nline2\nline3");
  });

  it("deletes text within a single line", () => {
    const result = applyEditsToContent("hello beautiful world", [
      { type: "delete", line: 1, column: 6, endLine: 1, endColumn: 16 },
    ]);
    expect(result).toBe("hello world");
  });

  it("deletes across multiple lines", () => {
    const result = applyEditsToContent("line1\nline2\nline3", [
      { type: "delete", line: 1, column: 6, endLine: 3, endColumn: 1 },
    ]);
    expect(result).toBe("line1line3");
  });

  it("deletes an entire line", () => {
    const result = applyEditsToContent("line1\nline2\nline3", [
      { type: "delete", line: 2, column: 1, endLine: 3, endColumn: 1 },
    ]);
    expect(result).toBe("line1\nline3");
  });

  it("replaces text within a single line", () => {
    const result = applyEditsToContent("hello world", [
      {
        type: "replace",
        line: 1,
        column: 7,
        endLine: 1,
        endColumn: 12,
        text: "earth",
      },
    ]);
    expect(result).toBe("hello earth");
  });

  it("replaces text across multiple lines", () => {
    const result = applyEditsToContent("aaa\nbbb\nccc", [
      {
        type: "replace",
        line: 1,
        column: 4,
        endLine: 3,
        endColumn: 1,
        text: "XXX\n",
      },
    ]);
    expect(result).toBe("aaaXXX\nccc");
  });

  it("replaces with multi-line text", () => {
    const result = applyEditsToContent("hello world", [
      {
        type: "replace",
        line: 1,
        column: 6,
        endLine: 1,
        endColumn: 7,
        text: "\n",
      },
    ]);
    expect(result).toBe("hello\nworld");
  });

  it("applies multiple edits in correct order (reverse position)", () => {
    // Insert at two positions — both should work regardless of input order
    const result = applyEditsToContent("ab", [
      { type: "insert", line: 1, column: 2, text: "X" },
      { type: "insert", line: 1, column: 1, text: "Y" },
    ]);
    expect(result).toBe("YaXb");
  });

  it("applies edits on different lines", () => {
    const result = applyEditsToContent("line1\nline2\nline3", [
      {
        type: "replace",
        line: 3,
        column: 1,
        endLine: 3,
        endColumn: 6,
        text: "LINE3",
      },
      {
        type: "replace",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 6,
        text: "LINE1",
      },
    ]);
    expect(result).toBe("LINE1\nline2\nLINE3");
  });

  it("handles empty file", () => {
    const result = applyEditsToContent("", [
      { type: "insert", line: 1, column: 1, text: "hello" },
    ]);
    expect(result).toBe("hello");
  });

  it("handles insert beyond end of file (out-of-bounds line)", () => {
    const result = applyEditsToContent("line1", [
      { type: "insert", line: 5, column: 1, text: "line5" },
    ]);
    expect(result).toBe("line1\n\n\n\nline5");
  });

  it("handles delete that removes everything", () => {
    const result = applyEditsToContent("hello", [
      { type: "delete", line: 1, column: 1, endLine: 1, endColumn: 6 },
    ]);
    expect(result).toBe("");
  });

  it("rejects overlapping edits (replace lines 3-7 and replace lines 5-9)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    // These two edits overlap: first covers lines 3-7, second covers lines 5-9
    expect(() =>
      applyEditsToContent(lines, [
        {
          type: "replace",
          line: 3,
          column: 1,
          endLine: 7,
          endColumn: 6,
          text: "REPLACED_A",
        },
        {
          type: "replace",
          line: 5,
          column: 1,
          endLine: 9,
          endColumn: 6,
          text: "REPLACED_B",
        },
      ]),
    ).toThrow(/overlapping edits/i);
  });
});

// ── File operation tool fallbacks (real fs, disconnected extension) ────────

function mockDisconnectedExtensionClient(): any {
  return {
    isConnected: () => false,
    createFile: () => null,
    deleteFile: () => null,
    renameFile: () => null,
  };
}

describe("createFile native fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createCreateFileTool>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-create-"));
    tool = createCreateFileTool(workspace, mockDisconnectedExtensionClient());
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("creates a file with content", async () => {
    const result = await tool.handler({
      filePath: "test.txt",
      content: "hello",
    });
    expect((result as any).isError).toBeUndefined();
    const content = fs.readFileSync(path.join(workspace, "test.txt"), "utf-8");
    expect(content).toBe("hello");
  });

  it("creates a directory", async () => {
    const result = await tool.handler({ filePath: "mydir", isDirectory: true });
    expect((result as any).isError).toBeUndefined();
    const stat = fs.statSync(path.join(workspace, "mydir"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates nested directories for file", async () => {
    const result = await tool.handler({
      filePath: "deep/nested/file.txt",
      content: "nested",
    });
    expect((result as any).isError).toBeUndefined();
    const content = fs.readFileSync(
      path.join(workspace, "deep/nested/file.txt"),
      "utf-8",
    );
    expect(content).toBe("nested");
  });

  it("refuses to overwrite without flag", async () => {
    fs.writeFileSync(path.join(workspace, "existing.txt"), "old");
    const result = await tool.handler({
      filePath: "existing.txt",
      content: "new",
    });
    expect((result as any).isError).toBe(true);
    // Original content preserved
    expect(fs.readFileSync(path.join(workspace, "existing.txt"), "utf-8")).toBe(
      "old",
    );
  });

  it("overwrites with flag", async () => {
    fs.writeFileSync(path.join(workspace, "overwrite.txt"), "old");
    const result = await tool.handler({
      filePath: "overwrite.txt",
      content: "new",
      overwrite: true,
    });
    expect((result as any).isError).toBeUndefined();
    expect(
      fs.readFileSync(path.join(workspace, "overwrite.txt"), "utf-8"),
    ).toBe("new");
  });
});

describe("deleteFile native fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createDeleteFileTool>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-delete-"));
    tool = createDeleteFileTool(workspace, mockDisconnectedExtensionClient());
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("refuses trash deletion without extension", async () => {
    fs.writeFileSync(path.join(workspace, "trash-me.txt"), "data");
    const result = await tool.handler({
      filePath: "trash-me.txt",
      useTrash: true,
    });
    expect((result as any).isError).toBe(true);
    // File should still exist
    expect(fs.existsSync(path.join(workspace, "trash-me.txt"))).toBe(true);
  });

  it("permanently deletes a file when useTrash is false", async () => {
    fs.writeFileSync(path.join(workspace, "delete-me.txt"), "data");
    const result = await tool.handler({
      filePath: "delete-me.txt",
      useTrash: false,
    });
    expect((result as any).isError).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, "delete-me.txt"))).toBe(false);
  });

  it("refuses to delete directory without recursive", async () => {
    fs.mkdirSync(path.join(workspace, "mydir"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "mydir/file.txt"), "data");
    const result = await tool.handler({ filePath: "mydir", useTrash: false });
    expect((result as any).isError).toBe(true);
  });

  it("deletes directory recursively", async () => {
    fs.mkdirSync(path.join(workspace, "rmdir"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rmdir/file.txt"), "data");
    const result = await tool.handler({
      filePath: "rmdir",
      useTrash: false,
      recursive: true,
    });
    expect((result as any).isError).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, "rmdir"))).toBe(false);
  });
});

describe("renameFile native fallback", () => {
  let workspace: string;
  let tool: ReturnType<typeof createRenameFileTool>;

  const cleanupDirs: string[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-rename-"));
    cleanupDirs.push(workspace);
    tool = createRenameFileTool(workspace, mockDisconnectedExtensionClient());
  });

  afterAll(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renames a file", async () => {
    fs.writeFileSync(path.join(workspace, "old.txt"), "data");
    const result = await tool.handler({
      oldPath: "old.txt",
      newPath: "new.txt",
    });
    expect((result as any).isError).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, "old.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "new.txt"), "utf-8")).toBe(
      "data",
    );
  });

  it("moves to a nested path (creates parent dirs)", async () => {
    fs.writeFileSync(path.join(workspace, "src.txt"), "data");
    const result = await tool.handler({
      oldPath: "src.txt",
      newPath: "a/b/dest.txt",
    });
    expect((result as any).isError).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "a/b/dest.txt"), "utf-8")).toBe(
      "data",
    );
  });

  it("refuses to overwrite without flag", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "aaa");
    fs.writeFileSync(path.join(workspace, "b.txt"), "bbb");
    const result = await tool.handler({ oldPath: "a.txt", newPath: "b.txt" });
    expect((result as any).isError).toBe(true);
    // Both files should still exist with original content
    expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf-8")).toBe("bbb");
  });

  it("overwrites with flag", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "aaa");
    fs.writeFileSync(path.join(workspace, "b.txt"), "bbb");
    const result = await tool.handler({
      oldPath: "a.txt",
      newPath: "b.txt",
      overwrite: true,
    });
    expect((result as any).isError).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf-8")).toBe("aaa");
  });
});
