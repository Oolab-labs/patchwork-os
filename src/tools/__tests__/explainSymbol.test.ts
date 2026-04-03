import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createExplainSymbolTool } from "../explainSymbol.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;
let testFile: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "explain-symbol-test-"));
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
    getHover: vi.fn().mockResolvedValue({ contents: "string type" }),
    goToDefinition: vi.fn().mockResolvedValue({ uri: "file:///a.ts", line: 1 }),
    getCallHierarchy: vi.fn().mockResolvedValue({ callers: [], callees: [] }),
    findReferences: vi
      .fn()
      .mockResolvedValue([{ uri: "file:///b.ts", line: 5 }]),
    getTypeHierarchy: vi
      .fn()
      .mockResolvedValue({ supertypes: [], subtypes: [] }),
    getCodeActions: vi
      .fn()
      .mockResolvedValue([{ title: "Rename Symbol", kind: "refactor.rename" }]),
  } as any;
}

describe("explainSymbol", () => {
  it("returns all 4 fields when all calls succeed", async () => {
    const ext = makeMockClient();
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.hover).toEqual({ contents: "string type" });
    expect(result.definition).toEqual({ uri: "file:///a.ts", line: 1 });
    expect(result.callHierarchy).toEqual({ callers: [], callees: [] });
    expect(result.references).toEqual([{ uri: "file:///b.ts", line: 5 }]);
  });

  it("returns null for failed calls, others populated", async () => {
    const ext = makeMockClient();
    ext.getHover.mockRejectedValue(new Error("timeout"));
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.hover).toBeNull();
    expect(result.definition).toEqual({ uri: "file:///a.ts", line: 1 });
    expect(result.callHierarchy).toEqual({ callers: [], callees: [] });
    expect(result.references).toEqual([{ uri: "file:///b.ts", line: 5 }]);
  });

  it("returns isError when extension is disconnected", async () => {
    const ext = makeMockClient(false);
    const tool = createExplainSymbolTool(workspace, ext);
    const raw = await tool.handler({
      filePath: testFile,
      line: 1,
      column: 1,
    });
    expect(raw.isError).toBe(true);
  });

  it("returns all nulls when all calls return null", async () => {
    const ext = makeMockClient();
    ext.getHover.mockResolvedValue(null);
    ext.goToDefinition.mockResolvedValue(null);
    ext.getCallHierarchy.mockResolvedValue(null);
    ext.findReferences.mockResolvedValue(null);
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(result.hover).toBeNull();
    expect(result.definition).toBeNull();
    expect(result.callHierarchy).toBeNull();
    expect(result.references).toBeNull();
  });
});

describe("explainSymbol — optional flags", () => {
  it("does not call getTypeHierarchy or getCodeActions by default", async () => {
    const ext = makeMockClient();
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 1 }),
    );
    expect(ext.getTypeHierarchy).not.toHaveBeenCalled();
    expect(ext.getCodeActions).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("typeHierarchy");
    expect(result).not.toHaveProperty("codeActions");
  });

  it("calls getTypeHierarchy and includes typeHierarchy field when includeTypeHierarchy=true", async () => {
    const ext = makeMockClient();
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({
        filePath: testFile,
        line: 1,
        column: 1,
        includeTypeHierarchy: true,
      }),
    );
    expect(ext.getTypeHierarchy).toHaveBeenCalledOnce();
    expect(ext.getCodeActions).not.toHaveBeenCalled();
    expect(result.typeHierarchy).toEqual({ supertypes: [], subtypes: [] });
    expect(result).not.toHaveProperty("codeActions");
  });

  it("calls getCodeActions and includes codeActions field when includeCodeActions=true", async () => {
    const ext = makeMockClient();
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({
        filePath: testFile,
        line: 1,
        column: 1,
        includeCodeActions: true,
      }),
    );
    expect(ext.getCodeActions).toHaveBeenCalledOnce();
    expect(ext.getTypeHierarchy).not.toHaveBeenCalled();
    expect(result.codeActions).toEqual([
      { title: "Rename Symbol", kind: "refactor.rename" },
    ]);
    expect(result).not.toHaveProperty("typeHierarchy");
  });

  it("calls both methods and includes both fields when both flags are true", async () => {
    const ext = makeMockClient();
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({
        filePath: testFile,
        line: 1,
        column: 1,
        includeTypeHierarchy: true,
        includeCodeActions: true,
      }),
    );
    expect(ext.getTypeHierarchy).toHaveBeenCalledOnce();
    expect(ext.getCodeActions).toHaveBeenCalledOnce();
    expect(result.typeHierarchy).toEqual({ supertypes: [], subtypes: [] });
    expect(result.codeActions).toEqual([
      { title: "Rename Symbol", kind: "refactor.rename" },
    ]);
  });

  it("returns null typeHierarchy but valid codeActions when getTypeHierarchy rejects", async () => {
    const ext = makeMockClient();
    ext.getTypeHierarchy.mockRejectedValue(new Error("hierarchy failed"));
    const tool = createExplainSymbolTool(workspace, ext);
    const result = parse(
      await tool.handler({
        filePath: testFile,
        line: 1,
        column: 1,
        includeTypeHierarchy: true,
        includeCodeActions: true,
      }),
    );
    expect(result.typeHierarchy).toBeNull();
    expect(result.codeActions).toEqual([
      { title: "Rename Symbol", kind: "refactor.rename" },
    ]);
  });
});
