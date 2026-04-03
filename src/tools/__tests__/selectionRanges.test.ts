import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createSelectionRangesTool } from "../selectionRanges.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;
let testFile: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "selection-ranges-test-"));
  testFile = path.join(workspace, "src", "a.ts");
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, "const x = 1;\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeMockClient(connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    selectionRanges: vi.fn().mockResolvedValue({ ranges: [], count: 0 }),
  } as any;
}

describe("createSelectionRangesTool", () => {
  it("returns ranges ordered innermost to outermost", async () => {
    const ext = makeMockClient();
    ext.selectionRanges.mockResolvedValue({
      ranges: [
        { startLine: 1, startColumn: 5, endLine: 1, endColumn: 10 },
        { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 },
      ],
    });
    const tool = createSelectionRangesTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 7 }),
    );
    expect(result.count).toBe(2);
    expect(result.ranges).toHaveLength(2);
    expect(result.ranges[0]).toMatchObject({ startColumn: 5, endColumn: 10 });
    expect(result.ranges[1]).toMatchObject({ startColumn: 1, endColumn: 20 });
  });

  it("returns count=0 for empty ranges", async () => {
    const ext = makeMockClient();
    ext.selectionRanges.mockResolvedValue({ ranges: [] });
    const tool = createSelectionRangesTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.count).toBe(0);
    expect(result.ranges).toHaveLength(0);
  });

  it("returns empty ranges when extension returns null", async () => {
    const ext = makeMockClient();
    ext.selectionRanges.mockResolvedValue(null);
    const tool = createSelectionRangesTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.count).toBe(0);
    expect(result.ranges).toHaveLength(0);
  });

  it("returns cold start error when extension times out after retries", async () => {
    const ext = makeMockClient();
    ext.selectionRanges.mockRejectedValue(new ExtensionTimeoutError("timeout"));
    const tool = createSelectionRangesTool(workspace, ext);
    const controller = new AbortController();
    controller.abort();
    const result = await tool.handler(
      { filePath: testFile, line: 1, column: 1 },
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out|indexing/i);
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const ext = makeMockClient(false);
    const tool = createSelectionRangesTool(workspace, ext);
    const result = await tool.handler({
      filePath: testFile,
      line: 1,
      column: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });
});
