import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createFoldingRangesTool } from "../foldingRanges.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;
let testFile: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "folding-ranges-test-"));
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
    foldingRanges: vi.fn().mockResolvedValue({ ranges: [], count: 0 }),
  } as any;
}

describe("createFoldingRangesTool", () => {
  it("returns ranges when extension returns data", async () => {
    const ext = makeMockClient();
    ext.foldingRanges.mockResolvedValue({
      ranges: [
        { startLine: 1, endLine: 5, kind: "region" },
        { startLine: 10, endLine: 20, kind: "imports" },
      ],
    });
    const tool = createFoldingRangesTool(workspace, ext);
    const result = parse(await tool.handler({ filePath: testFile }));
    expect(result.count).toBe(2);
    expect(result.ranges).toHaveLength(2);
    expect(result.ranges[0]).toMatchObject({
      startLine: 1,
      endLine: 5,
      kind: "region",
    });
    expect(result.ranges[1]).toMatchObject({
      startLine: 10,
      endLine: 20,
      kind: "imports",
    });
  });

  it("returns count=0 for empty ranges", async () => {
    const ext = makeMockClient();
    ext.foldingRanges.mockResolvedValue({ ranges: [] });
    const tool = createFoldingRangesTool(workspace, ext);
    const result = parse(await tool.handler({ filePath: testFile }));
    expect(result.count).toBe(0);
    expect(result.ranges).toHaveLength(0);
  });

  it("returns empty ranges when extension returns null", async () => {
    const ext = makeMockClient();
    ext.foldingRanges.mockResolvedValue(null);
    const tool = createFoldingRangesTool(workspace, ext);
    const result = parse(await tool.handler({ filePath: testFile }));
    expect(result.count).toBe(0);
    expect(result.ranges).toHaveLength(0);
  });

  it("returns cold start error when extension times out after retries", async () => {
    const ext = makeMockClient();
    ext.foldingRanges.mockRejectedValue(new ExtensionTimeoutError("timeout"));
    const tool = createFoldingRangesTool(workspace, ext);
    // Use an already-aborted signal so lspWithRetry short-circuits without delays
    const controller = new AbortController();
    controller.abort();
    const result = await tool.handler(
      { filePath: testFile },
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out|indexing/i);
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const ext = makeMockClient(false);
    const tool = createFoldingRangesTool(workspace, ext);
    const result = await tool.handler({ filePath: testFile });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });
});
