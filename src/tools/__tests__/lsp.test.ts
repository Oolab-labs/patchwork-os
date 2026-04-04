import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import {
  createApplyCodeActionTool,
  createFindReferencesTool,
  createGetCallHierarchyTool,
  createGetCodeActionsTool,
  createGetHoverTool,
  createGoToDefinitionTool,
  createRenameSymbolTool,
} from "../lsp.js";

let workspace: string;
let testFilePath: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
  testFilePath = path.join(workspace, "test.ts");
  fs.writeFileSync(testFilePath, "const x = 1;\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeClient(opts: {
  connected: boolean;
  result?: unknown;
  throwTimeout?: boolean;
}) {
  const mockFn = vi.fn(async () => {
    if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
    return opts.result ?? null;
  });
  return {
    isConnected: vi.fn(() => opts.connected),
    goToDefinition: mockFn,
    findReferences: mockFn,
    getHover: mockFn,
    getCodeActions: mockFn,
    applyCodeAction: mockFn,
    renameSymbol: mockFn,
    getCallHierarchy: mockFn,
  } as any;
}

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const baseArgs = () => ({ filePath: testFilePath, line: 1, column: 1 });

// ---------------------------------------------------------------------------
// goToDefinition
// ---------------------------------------------------------------------------

describe("createGoToDefinitionTool", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createGoToDefinitionTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });

  it("returns found:false when extension returns null", async () => {
    const tool = createGoToDefinitionTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).found).toBe(false);
  });

  it("returns definition data on success", async () => {
    const def = {
      uri: "file:///test.ts",
      range: { start: { line: 0, character: 0 } },
    };
    const tool = createGoToDefinitionTool(
      workspace,
      makeClient({ connected: true, result: def }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).uri).toBe("file:///test.ts");
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGoToDefinitionTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// findReferences
// ---------------------------------------------------------------------------

describe("createFindReferencesTool", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createFindReferencesTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
  });

  it("returns empty references when extension returns null", async () => {
    const tool = createFindReferencesTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.found).toBe(false);
    expect(data.references).toEqual([]);
  });

  it("returns reference data on success", async () => {
    const refs = { references: [{ uri: "file:///test.ts", range: {} }] };
    const tool = createFindReferencesTool(
      workspace,
      makeClient({ connected: true, result: refs }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).references).toHaveLength(1);
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createFindReferencesTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// getHover
// ---------------------------------------------------------------------------

describe("createGetHoverTool", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetHoverTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
  });

  it("returns found:false when extension returns null", async () => {
    const tool = createGetHoverTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).found).toBe(false);
  });

  it("returns hover data on success", async () => {
    const hover = { contents: "const x: number", range: {} };
    const tool = createGetHoverTool(
      workspace,
      makeClient({ connected: true, result: hover }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).contents).toBe("const x: number");
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGetHoverTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// getCodeActions
// ---------------------------------------------------------------------------

describe("createGetCodeActionsTool", () => {
  const rangeArgs = () => ({
    filePath: testFilePath,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 5,
  });

  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetCodeActionsTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(rangeArgs());
    expect(result.isError).toBe(true);
  });

  it("returns empty actions when extension returns null", async () => {
    const tool = createGetCodeActionsTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(rangeArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).actions).toEqual([]);
  });

  it("returns actions on success", async () => {
    const actions = { actions: [{ title: "Fix: add missing import" }] };
    const tool = createGetCodeActionsTool(
      workspace,
      makeClient({ connected: true, result: actions }),
    );
    const result = await tool.handler(rangeArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).actions).toHaveLength(1);
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGetCodeActionsTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(rangeArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// applyCodeAction
// ---------------------------------------------------------------------------

describe("createApplyCodeActionTool", () => {
  const applyArgs = () => ({
    filePath: testFilePath,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 5,
    actionTitle: "Fix: add missing import",
  });

  it("returns extensionRequired when disconnected", async () => {
    const tool = createApplyCodeActionTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(applyArgs());
    expect(result.isError).toBe(true);
  });

  it("returns error when extension returns null", async () => {
    const tool = createApplyCodeActionTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(applyArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no result");
  });

  it("returns success data when action applied", async () => {
    const applied = { applied: true, editCount: 2 };
    const tool = createApplyCodeActionTool(
      workspace,
      makeClient({ connected: true, result: applied }),
    );
    const result = await tool.handler(applyArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).applied).toBe(true);
  });

  it("returns timeout error on ExtensionTimeoutError", async () => {
    const tool = createApplyCodeActionTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(applyArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// renameSymbol
// ---------------------------------------------------------------------------

describe("createRenameSymbolTool", () => {
  const renameArgs = () => ({
    filePath: testFilePath,
    line: 1,
    column: 1,
    newName: "y",
  });

  it("returns extensionRequired when disconnected", async () => {
    const tool = createRenameSymbolTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(renameArgs());
    expect(result.isError).toBe(true);
  });

  it("returns error when extension returns null", async () => {
    const tool = createRenameSymbolTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(renameArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no result");
  });

  it("returns rename result on success", async () => {
    const renamed = { affectedFiles: ["test.ts"], editCount: 3 };
    const tool = createRenameSymbolTool(
      workspace,
      makeClient({ connected: true, result: renamed }),
    );
    const result = await tool.handler(renameArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).editCount).toBe(3);
  });

  it("rejects newName with control characters", async () => {
    const tool = createRenameSymbolTool(
      workspace,
      makeClient({ connected: true }),
    );
    const result = await tool.handler({
      ...renameArgs(),
      newName: "bad\x01name",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("control characters");
  });

  it("returns timeout error on ExtensionTimeoutError", async () => {
    const tool = createRenameSymbolTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(renameArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// getCallHierarchy
// ---------------------------------------------------------------------------

describe("createGetCallHierarchyTool", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetCallHierarchyTool(
      workspace,
      makeClient({ connected: false }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
  });

  it("returns found:false when extension returns null", async () => {
    const tool = createGetCallHierarchyTool(
      workspace,
      makeClient({ connected: true, result: null }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).found).toBe(false);
  });

  it("returns hierarchy data on success", async () => {
    const hier = { incoming: [{ name: "caller" }], outgoing: [] };
    const tool = createGetCallHierarchyTool(
      workspace,
      makeClient({ connected: true, result: hier }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBeFalsy();
    expect(parse(result).incoming).toHaveLength(1);
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGetCallHierarchyTool(
      workspace,
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(baseArgs());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("rejects invalid direction value", async () => {
    const tool = createGetCallHierarchyTool(
      workspace,
      makeClient({ connected: true }),
    );
    const result = await tool.handler({ ...baseArgs(), direction: "sideways" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("direction");
  });

  it("respects direction=incoming", async () => {
    const hier = { incoming: [{ name: "caller" }] };
    const client = makeClient({ connected: true, result: hier });
    const tool = createGetCallHierarchyTool(workspace, client);
    await tool.handler({ ...baseArgs(), direction: "incoming" });
    expect(client.getCallHierarchy).toHaveBeenCalledWith(
      testFilePath,
      1,
      1,
      "incoming",
      expect.any(Number),
      undefined,
    );
  });
});
