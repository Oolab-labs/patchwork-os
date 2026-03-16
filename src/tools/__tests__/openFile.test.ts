/**
 * Tests for openFile.ts — file-not-found, openedFiles cap, no-editor fallback,
 * extension path, and CLI spawn path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenFileTool } from "../openFile.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const disconnected = { isConnected: () => false } as any;

describe("openFile — file validation", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openfile-")),
    );
    filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns error when file does not exist", async () => {
    const tool = createOpenFileTool(tmpDir, null, new Set(), disconnected);
    const result = parse(await tool.handler({ filePath: "nonexistent.ts" }));
    expect(result.error).toMatch(/not found/i);
  });

  it("succeeds when file exists (no editor configured)", async () => {
    const tool = createOpenFileTool(tmpDir, null, new Set(), disconnected);
    const result = parse(await tool.handler({ filePath: "test.ts" }));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/no editor/i);
  });

  it("adds file to openedFiles set", async () => {
    const openedFiles = new Set<string>();
    const tool = createOpenFileTool(tmpDir, null, openedFiles, disconnected);
    await tool.handler({ filePath: "test.ts" });
    expect(openedFiles.has(filePath)).toBe(true);
  });

  it("evicts oldest entry when openedFiles exceeds 500", async () => {
    const openedFiles = new Set<string>();
    // Pre-fill with 500 entries
    for (let i = 0; i < 500; i++) {
      openedFiles.add(`/fake/path/file${i}.ts`);
    }
    const oldest = openedFiles.values().next().value;
    const tool = createOpenFileTool(tmpDir, null, openedFiles, disconnected);
    await tool.handler({ filePath: "test.ts" });
    // Set still at 500 (evicted one, added one)
    expect(openedFiles.size).toBe(500);
    expect(openedFiles.has(oldest)).toBe(false);
    expect(openedFiles.has(filePath)).toBe(true);
  });
});

describe("openFile — extension path", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openfile-ext-")),
    );
    filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "hello\nworld\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("uses extension when connected", async () => {
    const ext = {
      isConnected: () => true,
      openFile: vi.fn().mockResolvedValue(true),
    } as any;
    const tool = createOpenFileTool(tmpDir, null, new Set(), ext);
    const result = parse(await tool.handler({ filePath: "test.ts" }));
    expect(ext.openFile).toHaveBeenCalledOnce();
    expect(result.via).toBe("extension");
  });

  it("passes startLine to extension when provided", async () => {
    const ext = {
      isConnected: () => true,
      openFile: vi.fn().mockResolvedValue(true),
    } as any;
    const tool = createOpenFileTool(tmpDir, null, new Set(), ext);
    await tool.handler({ filePath: "test.ts", startLine: 2 });
    expect(ext.openFile).toHaveBeenCalledWith(filePath, 2);
  });

  it("finds line number for startText and passes it to extension", async () => {
    const ext = {
      isConnected: () => true,
      openFile: vi.fn().mockResolvedValue(true),
    } as any;
    const tool = createOpenFileTool(tmpDir, null, new Set(), ext);
    await tool.handler({ filePath: "test.ts", startText: "world" });
    expect(ext.openFile).toHaveBeenCalledWith(filePath, 2);
  });

  it("startLine takes precedence over startText when both provided (regression: was inverted)", async () => {
    // File has "hello" on line 1, "world" on line 2.
    // startLine: 1 should win — extension must be called with line 1, not 2.
    const ext = {
      isConnected: () => true,
      openFile: vi.fn().mockResolvedValue(true),
    } as any;
    const tool = createOpenFileTool(tmpDir, null, new Set(), ext);
    await tool.handler({
      filePath: "test.ts",
      startLine: 1,
      startText: "world",
    });
    expect(ext.openFile).toHaveBeenCalledWith(filePath, 1);
  });
});

describe("openFile — no editor command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openfile-noeditor-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "x\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns success with message when no editorCommand and extension disconnected", async () => {
    const tool = createOpenFileTool(tmpDir, null, new Set(), disconnected);
    const result = parse(await tool.handler({ filePath: "test.ts" }));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/no editor/i);
  });
});
