import { describe, expect, it, vi } from "vitest";
import {
  createBatchFindImplementationsTool,
  createBatchGetHoverTool,
  createBatchGoToDefinitionTool,
} from "../batchLsp.js";

const workspace = "/tmp";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    isConnected: vi.fn(() => true),
    getHover: vi.fn(() =>
      Promise.resolve({ contents: ["function foo(): void"], range: null }),
    ),
    goToDefinition: vi.fn(() =>
      Promise.resolve([{ file: "/tmp/lib.ts", line: 5, column: 1 }]),
    ),
    findImplementations: vi.fn(() =>
      Promise.resolve([{ file: "/tmp/impl.ts", line: 10, column: 1 }]),
    ),
    ...overrides,
  };
}

const ITEM = { filePath: "/tmp/foo.ts", line: 3, column: 7 };

// ── batchGetHover ─────────────────────────────────────────────────────────────

describe("batchGetHover", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createBatchGetHoverTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("throws when items is missing", async () => {
    const client = makeClient();
    const tool = createBatchGetHoverTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow("items must be an array");
  });

  it("throws when items is empty", async () => {
    const client = makeClient();
    const tool = createBatchGetHoverTool(workspace, client as never);
    await expect(tool.handler({ items: [] })).rejects.toThrow("empty");
  });

  it("throws when items exceeds 10", async () => {
    const client = makeClient();
    const tool = createBatchGetHoverTool(workspace, client as never);
    const tooMany = Array.from({ length: 11 }, () => ITEM);
    await expect(tool.handler({ items: tooMany })).rejects.toThrow("maximum");
  });

  it("returns results for each item", async () => {
    const client = makeClient();
    const tool = createBatchGetHoverTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM, ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.results[0].result).not.toBeNull();
  });

  it("returns null result when hover returns null", async () => {
    const client = makeClient({ getHover: vi.fn(() => Promise.resolve(null)) });
    const tool = createBatchGetHoverTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].result).toBeNull();
  });

  it("returns null result when hover rejects", async () => {
    const client = makeClient({
      getHover: vi.fn(() => Promise.reject(new Error("unavailable"))),
    });
    const tool = createBatchGetHoverTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].result).toBeNull();
  });

  it("includes filePath/line/column in each result", async () => {
    const client = makeClient();
    const tool = createBatchGetHoverTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].filePath).toBe("/tmp/foo.ts");
    expect(data.results[0].line).toBe(3);
    expect(data.results[0].column).toBe(7);
  });
});

// ── batchGoToDefinition ───────────────────────────────────────────────────────

describe("batchGoToDefinition", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createBatchGoToDefinitionTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("throws when items exceeds 10", async () => {
    const client = makeClient();
    const tool = createBatchGoToDefinitionTool(workspace, client as never);
    const tooMany = Array.from({ length: 11 }, () => ITEM);
    await expect(tool.handler({ items: tooMany })).rejects.toThrow("maximum");
  });

  it("returns definition locations for each item", async () => {
    const client = makeClient();
    const tool = createBatchGoToDefinitionTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].result).toEqual([
      { file: "/tmp/lib.ts", line: 5, column: 1 },
    ]);
  });

  it("handles partial failures gracefully", async () => {
    const client = makeClient({
      goToDefinition: vi
        .fn()
        .mockResolvedValueOnce([{ file: "/tmp/a.ts", line: 1, column: 1 }])
        .mockRejectedValueOnce(new Error("lsp error")),
    });
    const tool = createBatchGoToDefinitionTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM, ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].result).not.toBeNull();
    expect(data.results[1].result).toBeNull();
  });
});

// ── batchFindImplementations ──────────────────────────────────────────────────

describe("batchFindImplementations", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("throws when items is missing", async () => {
    const client = makeClient();
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    await expect(tool.handler({})).rejects.toThrow("items must be an array");
  });

  it("throws when items is empty", async () => {
    const client = makeClient();
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    await expect(tool.handler({ items: [] })).rejects.toThrow("empty");
  });

  it("throws when items exceeds 10", async () => {
    const client = makeClient();
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const tooMany = Array.from({ length: 11 }, () => ITEM);
    await expect(tool.handler({ items: tooMany })).rejects.toThrow("maximum");
  });

  it("returns implementation locations for each item", async () => {
    const client = makeClient();
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(data.results[0].result).toEqual([
      { file: "/tmp/impl.ts", line: 10, column: 1 },
    ]);
  });

  it("includes filePath/line/column in each result", async () => {
    const client = makeClient();
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].filePath).toBe("/tmp/foo.ts");
    expect(data.results[0].line).toBe(3);
    expect(data.results[0].column).toBe(7);
  });

  it("returns null result when findImplementations returns null", async () => {
    const client = makeClient({
      findImplementations: vi.fn(() => Promise.resolve(null)),
    });
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].result).toBeNull();
  });

  it("handles partial failures gracefully", async () => {
    const client = makeClient({
      findImplementations: vi
        .fn()
        .mockResolvedValueOnce([{ file: "/tmp/a.ts", line: 1, column: 1 }])
        .mockRejectedValueOnce(new Error("lsp error")),
    });
    const tool = createBatchFindImplementationsTool(workspace, client as never);
    const result = (await tool.handler({ items: [ITEM, ITEM] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].result).not.toBeNull();
    expect(data.results[1].result).toBeNull();
  });
});
