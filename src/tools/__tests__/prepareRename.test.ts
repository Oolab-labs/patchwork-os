import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createPrepareRenameTool } from "../lsp.js";

let workspace: string;
let testFilePath: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "prepareRename-test-"));
  testFilePath = path.join(workspace, "test.ts");
  fs.writeFileSync(testFilePath, "const foo = 1;\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeClient(opts: {
  connected: boolean;
  result?: object | null;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    prepareRename: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.result ?? null;
    }),
  } as any;
}

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createPrepareRenameTool", () => {
  it("returns canRename:true with range and placeholder when renaming is supported", async () => {
    const renameData = {
      canRename: true,
      range: { start: { line: 1, col: 1 }, end: { line: 1, col: 5 } },
      placeholder: "foo",
    };
    const tool = createPrepareRenameTool(
      workspace,
      makeClient({ connected: true, result: renameData }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.canRename).toBe(true);
    expect(data.placeholder).toBe("foo");
    expect(data.range).toBeDefined();
  });

  it("returns canRename:false with reason when renaming is not supported", async () => {
    const renameData = { canRename: false, reason: "built-in" };
    const tool = createPrepareRenameTool(
      workspace,
      makeClient({ connected: true, result: renameData }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.canRename).toBe(false);
    expect(data.reason).toBe("built-in");
  });

  it("returns canRename:false when extension returns null (symbol not renameable)", async () => {
    const tool = createPrepareRenameTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.canRename).toBe(false);
    expect(data.reason).toBeDefined();
  });

  it("returns cold start error when extension times out", async () => {
    const tool = createPrepareRenameTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const tool = createPrepareRenameTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      line: 1,
      column: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });
});
