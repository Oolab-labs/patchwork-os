import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRefactorAnalyzeTool } from "../refactorAnalyze.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;
let testFile: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-analyze-test-"));
  testFile = path.join(workspace, "src", "a.ts");
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, "function foo() {}\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeMockClient(connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    prepareRename: vi
      .fn()
      .mockResolvedValue({ canRename: true, placeholder: "foo" }),
    findReferences: vi
      .fn()
      .mockResolvedValue({ references: [{ uri: "file:///a.ts", line: 1 }] }),
    getCallHierarchy: vi
      .fn()
      .mockResolvedValue({ incoming: [{ name: "bar" }] }),
    getTypeHierarchy: vi.fn().mockResolvedValue(null),
  } as any;
}

describe("createRefactorAnalyzeTool", () => {
  it("returns risk=low with 2 refs, 1 caller, no inheritance", async () => {
    const ext = makeMockClient();
    ext.findReferences.mockResolvedValue({
      references: [
        { uri: "file:///a.ts", line: 1 },
        { uri: "file:///b.ts", line: 5 },
      ],
    });
    ext.getCallHierarchy.mockResolvedValue({ incoming: [{ name: "bar" }] });
    ext.getTypeHierarchy.mockResolvedValue(null);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    expect(result.risk).toBe("low");
    expect(result.referenceCount).toBe(2);
    expect(result.callerCount).toBe(1);
    expect(result.hasInheritance).toBe(false);
    expect(result.canRename).toBe(true);
  });

  it("returns risk=high with 25 references and 12 callers", async () => {
    const ext = makeMockClient();
    const refs = Array.from({ length: 25 }, (_, i) => ({
      uri: `file:///a${i}.ts`,
      line: i,
    }));
    const callers = Array.from({ length: 12 }, (_, i) => ({ name: `fn${i}` }));
    ext.findReferences.mockResolvedValue({ references: refs });
    ext.getCallHierarchy.mockResolvedValue({ incoming: callers });
    ext.getTypeHierarchy.mockResolvedValue(null);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    expect(result.risk).toBe("high");
    expect(result.referenceCount).toBe(25);
    expect(result.callerCount).toBe(12);
  });

  it("returns risk=medium with 10 refs, 5 callers, no inheritance", async () => {
    const ext = makeMockClient();
    const refs = Array.from({ length: 10 }, (_, i) => ({
      uri: `file:///a${i}.ts`,
      line: i,
    }));
    const callers = Array.from({ length: 5 }, (_, i) => ({ name: `fn${i}` }));
    ext.findReferences.mockResolvedValue({ references: refs });
    ext.getCallHierarchy.mockResolvedValue({ incoming: callers });
    ext.getTypeHierarchy.mockResolvedValue(null);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    expect(result.risk).toBe("medium");
    expect(result.referenceCount).toBe(10);
    expect(result.callerCount).toBe(5);
    expect(result.hasInheritance).toBe(false);
  });

  it("returns hasInheritance=true and risk=high when type hierarchy has supertypes", async () => {
    const ext = makeMockClient();
    // few refs and callers, but inheritance present → high
    ext.findReferences.mockResolvedValue({
      references: [{ uri: "file:///a.ts", line: 1 }],
    });
    ext.getCallHierarchy.mockResolvedValue({ incoming: [] });
    ext.getTypeHierarchy.mockResolvedValue({ supertypes: ["Base"] });
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    expect(result.hasInheritance).toBe(true);
    expect(result.risk).toBe("high");
  });

  it("handles partial failure: prepareRename rejects, rest still computed", async () => {
    const ext = makeMockClient();
    ext.prepareRename.mockRejectedValue(new Error("LSP error"));
    ext.findReferences.mockResolvedValue({
      references: [{ uri: "file:///a.ts", line: 1 }],
    });
    ext.getCallHierarchy.mockResolvedValue({ incoming: [] });
    ext.getTypeHierarchy.mockResolvedValue(null);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    // prepareRename rejected → canRename treated as false (null prepareData)
    expect(result.canRename).toBe(false);
    // references and callers still computed
    expect(result.referenceCount).toBe(1);
    expect(result.callerCount).toBe(0);
  });

  it("returns extensionRequired error when extension is disconnected", async () => {
    const ext = makeMockClient(false);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = await tool.handler({
      filePath: testFile,
      line: 1,
      column: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });

  it("summary string contains Risk level", async () => {
    const ext = makeMockClient();
    ext.findReferences.mockResolvedValue({
      references: [{ uri: "file:///a.ts", line: 1 }],
    });
    ext.getCallHierarchy.mockResolvedValue({ incoming: [] });
    ext.getTypeHierarchy.mockResolvedValue(null);
    const tool = createRefactorAnalyzeTool(workspace, ext);
    const result = parse(
      await tool.handler({ filePath: testFile, line: 1, column: 10 }),
    );
    expect(result.summary).toMatch(/^Risk: low/);
    expect(result.summary).toContain("reference");
    expect(result.summary).toContain("caller");
  });
});
