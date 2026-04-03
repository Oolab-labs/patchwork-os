import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createFormatRangeTool } from "../lsp.js";

let workspace: string;
let testFilePath: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "formatRange-test-"));
  testFilePath = path.join(workspace, "test.ts");
  fs.writeFileSync(testFilePath, "const x = 1;\nconst y = 2;\n");
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
    formatRange: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.result ?? null;
    }),
  } as any;
}

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createFormatRangeTool", () => {
  it("returns formatted:true and edit count when edits are applied", async () => {
    const formatData = { formatted: true, editsApplied: 3 };
    const tool = createFormatRangeTool(
      workspace,
      makeClient({ connected: true, result: formatData }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      startLine: 1,
      endLine: 10,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.formatted).toBe(true);
    expect(data.editsApplied).toBe(3);
  });

  it("returns formatted:true with no edits when already formatted", async () => {
    const formatData = { formatted: true, editsApplied: 0 };
    const tool = createFormatRangeTool(
      workspace,
      makeClient({ connected: true, result: formatData }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      startLine: 1,
      endLine: 10,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.formatted).toBe(true);
    expect(data.editsApplied).toBe(0);
  });

  it("returns formatted:false when extension returns null (no formatter available)", async () => {
    const tool = createFormatRangeTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      startLine: 1,
      endLine: 10,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.formatted).toBe(false);
  });

  it("returns error when endLine is less than startLine", async () => {
    const tool = createFormatRangeTool(
      workspace,
      makeClient({ connected: true }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      startLine: 10,
      endLine: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("endLine");
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const tool = createFormatRangeTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler({
      filePath: testFilePath,
      startLine: 1,
      endLine: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });
});
