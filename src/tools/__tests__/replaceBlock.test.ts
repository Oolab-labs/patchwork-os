import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplaceBlockTool } from "../replaceBlock.js";

function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  const raw = JSON.parse(result.content.at(0)?.text ?? "{}") as unknown;
  if (
    result.isError &&
    typeof raw === "object" &&
    raw !== null &&
    "error" in (raw as object) &&
    typeof (raw as Record<string, unknown>).error === "string"
  ) {
    return (raw as Record<string, unknown>).error as string;
  }
  return raw;
}

describe("replaceBlock TOCTOU bug", () => {
  let workspace: string;
  let tool: ReturnType<typeof createReplaceBlockTool>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-replaceblock-"));
    tool = createReplaceBlockTool(workspace);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("does not write the file if it was modified concurrently", async () => {
    const filePath = path.join(workspace, "target.txt");
    fs.writeFileSync(filePath, "hello world");

    // Track the order of fs operations to verify stat-before-write
    const ops: string[] = [];
    const originalStat = fsp.stat;
    const originalWriteFile = fsp.writeFile;
    const originalReadFile = fsp.readFile;

    let statCallCount = 0;

    vi.spyOn(fsp, "stat").mockImplementation(async (...args: any[]) => {
      statCallCount++;
      ops.push(`stat:${statCallCount}`);
      const result = await (originalStat as any).apply(fsp, args);
      if (statCallCount === 2) {
        // Simulate concurrent modification: change the file between the
        // second stat and whenever writeFile would be called.
        // We mutate the mtimeMs to simulate a changed file.
        result.mtimeMs = result.mtimeMs + 1000;
      }
      return result;
    });

    vi.spyOn(fsp, "readFile").mockImplementation(async (...args: any[]) => {
      ops.push("readFile");
      return (originalReadFile as any).apply(fsp, args);
    });

    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args: any[]) => {
      ops.push("writeFile");
      return (originalWriteFile as any).apply(fsp, args);
    });

    const result = await tool.handler({
      filePath: "target.txt",
      oldContent: "hello",
      newContent: "goodbye",
    });

    const parsed = parse(result as any);

    // The handler should detect concurrent modification and NOT write
    expect(parsed).toMatch(/modified concurrently/);
    expect((result as any).isError).toBe(true);

    // Crucially: writeFile must NOT have been called
    expect(ops).not.toContain("writeFile");

    // The file on disk must be unchanged
    const diskContent = fs.readFileSync(filePath, "utf-8");
    expect(diskContent).toBe("hello world");
  });

  it("checks mtime BEFORE writing, not after", async () => {
    const filePath = path.join(workspace, "order.txt");
    fs.writeFileSync(filePath, "aaa bbb ccc");

    const ops: string[] = [];
    const originalStat = fsp.stat;
    const originalWriteFile = fsp.writeFile;
    const originalReadFile = fsp.readFile;

    vi.spyOn(fsp, "stat").mockImplementation(async (...args: any[]) => {
      ops.push("stat");
      return (originalStat as any).apply(fsp, args);
    });

    vi.spyOn(fsp, "readFile").mockImplementation(async (...args: any[]) => {
      ops.push("readFile");
      return (originalReadFile as any).apply(fsp, args);
    });

    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args: any[]) => {
      ops.push("writeFile");
      return (originalWriteFile as any).apply(fsp, args);
    });

    await tool.handler({
      filePath: "order.txt",
      oldContent: "bbb",
      newContent: "xxx",
    });

    // The correct order is: stat (initial), readFile, stat (recheck), writeFile
    // The second stat MUST come BEFORE writeFile
    const secondStatIdx = ops.indexOf("stat", ops.indexOf("stat") + 1);
    const writeIdx = ops.indexOf("writeFile");

    expect(secondStatIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(secondStatIdx).toBeLessThan(writeIdx);
  });

  it("succeeds when file is not modified concurrently", async () => {
    const filePath = path.join(workspace, "good.txt");
    fs.writeFileSync(filePath, "foo bar baz");

    const result = await tool.handler({
      filePath: "good.txt",
      oldContent: "bar",
      newContent: "qux",
    });

    const parsed = parse(result as any);
    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("foo qux baz");
  });
});
