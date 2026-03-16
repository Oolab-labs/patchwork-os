/**
 * Tests for fileOperations.ts — createFile, deleteFile, renameFile.
 * Native fs paths tested directly; extension path tested via mock.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createRenameFileTool,
} from "../fileOperations.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const disconnected = { isConnected: () => false } as any;

// ── createFile ────────────────────────────────────────────────────────────────

describe("createFile — native fs (no extension)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "createfile-")),
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("creates a new file with content", async () => {
    const tool = createCreateFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "hello.txt", content: "hello world" }),
    );
    expect(result.created).toBe(true);
    expect(result.source).toContain("native-fs");
    expect(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf-8")).toBe(
      "hello world",
    );
  });

  it("creates a file with empty content by default", async () => {
    const tool = createCreateFileTool(tmpDir, disconnected);
    await tool.handler({ filePath: "empty.txt" });
    expect(fs.readFileSync(path.join(tmpDir, "empty.txt"), "utf-8")).toBe("");
  });

  it("creates a directory when isDirectory is true", async () => {
    const tool = createCreateFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "subdir", isDirectory: true }),
    );
    expect(result.created).toBe(true);
    expect(fs.statSync(path.join(tmpDir, "subdir")).isDirectory()).toBe(true);
  });

  it("creates parent directories automatically", async () => {
    const tool = createCreateFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "a/b/c/file.txt",
        content: "nested",
      }),
    );
    expect(result.created).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "a/b/c/file.txt"), "utf-8")).toBe(
      "nested",
    );
  });

  it("returns error when file already exists and overwrite is false", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(filePath, "original");
    const tool = createCreateFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "existing.txt", content: "new" }),
    );
    expect(result.error).toMatch(/already exists/i);
    // Original content preserved
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("overwrites when overwrite is true", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(filePath, "original");
    const tool = createCreateFileTool(tmpDir, disconnected);
    await tool.handler({
      filePath: "existing.txt",
      content: "replaced",
      overwrite: true,
    });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("replaced");
  });
});

describe("createFile — extension path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "createfile-ext-")),
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns extension result when connected and succeeds", async () => {
    const ext = {
      isConnected: () => true,
      createFile: vi.fn().mockResolvedValue({ created: true }),
    } as any;
    const tool = createCreateFileTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ filePath: "test.txt", content: "x" }),
    );
    expect(ext.createFile).toHaveBeenCalledOnce();
    expect(result.created).toBe(true);
  });

  it("falls through to native-fs when extension returns null", async () => {
    const ext = {
      isConnected: () => true,
      createFile: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createCreateFileTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ filePath: "test.txt", content: "x" }),
    );
    expect(result.source).toContain("native-fs");
    expect(fs.existsSync(path.join(tmpDir, "test.txt"))).toBe(true);
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe("deleteFile — native fs (no extension)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "deletefile-")),
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("permanently deletes a file when useTrash is false", async () => {
    const filePath = path.join(tmpDir, "to-delete.txt");
    fs.writeFileSync(filePath, "bye");
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "to-delete.txt", useTrash: false }),
    );
    expect(result.deleted).toBe(true);
    expect(result.source).toContain("native-fs");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns error when useTrash is true (default) and extension not connected", async () => {
    const filePath = path.join(tmpDir, "keep.txt");
    fs.writeFileSync(filePath, "keep");
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(await tool.handler({ filePath: "keep.txt" }));
    expect(result.error).toMatch(/trash/i);
    // File should NOT be deleted
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("returns error when trying to delete directory without recursive", async () => {
    const dirPath = path.join(tmpDir, "mydir");
    fs.mkdirSync(dirPath);
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "mydir", useTrash: false }),
    );
    expect(result.error).toMatch(/recursive/i);
    expect(fs.existsSync(dirPath)).toBe(true);
  });

  it("returns trash error (not recursive error) when deleting a directory with useTrash:true (regression)", async () => {
    // Regression: previously stat() ran before the useTrash check, so deleting a
    // directory with useTrash:true (default) returned "recursive required" instead
    // of the actionable "extension not connected, cannot trash" message.
    const dirPath = path.join(tmpDir, "mydir");
    fs.mkdirSync(dirPath);
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(await tool.handler({ filePath: "mydir" })); // useTrash defaults to true
    expect(result.error).toMatch(/trash/i);
    expect(result.error).not.toMatch(/recursive/i);
  });

  it("deletes a directory recursively when recursive is true", async () => {
    const dirPath = path.join(tmpDir, "mydir");
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, "inner.txt"), "inner");
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "mydir",
        useTrash: false,
        recursive: true,
      }),
    );
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  it("returns error when file does not exist", async () => {
    const tool = createDeleteFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "ghost.txt", useTrash: false }),
    );
    expect(result.error).toMatch(/failed to delete/i);
  });
});

describe("deleteFile — extension path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "deletefile-ext-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "content");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("uses extension when connected", async () => {
    const ext = {
      isConnected: () => true,
      deleteFile: vi.fn().mockResolvedValue({ deleted: true }),
    } as any;
    const tool = createDeleteFileTool(tmpDir, ext);
    const result = parse(await tool.handler({ filePath: "test.txt" }));
    expect(ext.deleteFile).toHaveBeenCalledOnce();
    expect(result.deleted).toBe(true);
  });

  it("falls through to native-fs when extension returns null", async () => {
    const ext = {
      isConnected: () => true,
      deleteFile: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createDeleteFileTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ filePath: "test.txt", useTrash: false }),
    );
    expect(result.source).toContain("native-fs");
    expect(fs.existsSync(path.join(tmpDir, "test.txt"))).toBe(false);
  });
});

// ── renameFile ────────────────────────────────────────────────────────────────

describe("renameFile — native fs (no extension)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "renamefile-")),
    );
    fs.writeFileSync(path.join(tmpDir, "old.txt"), "content");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("renames a file", async () => {
    const tool = createRenameFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ oldPath: "old.txt", newPath: "new.txt" }),
    );
    expect(result.renamed).toBe(true);
    expect(result.source).toContain("native-fs");
    expect(fs.existsSync(path.join(tmpDir, "new.txt"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "old.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "new.txt"), "utf-8")).toBe(
      "content",
    );
  });

  it("returns error when target already exists and overwrite is false", async () => {
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "existing");
    const tool = createRenameFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ oldPath: "old.txt", newPath: "new.txt" }),
    );
    expect(result.error).toMatch(/already exists/i);
    // Source still present
    expect(fs.existsSync(path.join(tmpDir, "old.txt"))).toBe(true);
  });

  it("overwrites target when overwrite is true", async () => {
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "old content");
    const tool = createRenameFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        oldPath: "old.txt",
        newPath: "new.txt",
        overwrite: true,
      }),
    );
    expect(result.renamed).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "new.txt"), "utf-8")).toBe(
      "content",
    );
  });

  it("creates target parent directories automatically", async () => {
    const tool = createRenameFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ oldPath: "old.txt", newPath: "sub/dir/new.txt" }),
    );
    expect(result.renamed).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "sub/dir/new.txt"), "utf-8")).toBe(
      "content",
    );
  });

  it("returns error when source file does not exist", async () => {
    const tool = createRenameFileTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ oldPath: "ghost.txt", newPath: "new.txt" }),
    );
    expect(result.error).toMatch(/failed to rename/i);
  });
});

describe("renameFile — extension path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "renamefile-ext-")),
    );
    fs.writeFileSync(path.join(tmpDir, "old.txt"), "content");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("uses extension when connected", async () => {
    const ext = {
      isConnected: () => true,
      renameFile: vi.fn().mockResolvedValue({ renamed: true }),
    } as any;
    const tool = createRenameFileTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ oldPath: "old.txt", newPath: "new.txt" }),
    );
    expect(ext.renameFile).toHaveBeenCalledOnce();
    expect(result.renamed).toBe(true);
  });

  it("falls through to native-fs when extension returns null", async () => {
    const ext = {
      isConnected: () => true,
      renameFile: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createRenameFileTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ oldPath: "old.txt", newPath: "new.txt" }),
    );
    expect(result.source).toContain("native-fs");
    expect(fs.existsSync(path.join(tmpDir, "new.txt"))).toBe(true);
  });
});
