import { describe, expect, it, vi } from "vitest";
import { createGetChangeImpactTool } from "../getChangeImpact.js";

const workspace = "/tmp";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    isConnected: vi.fn(() => true),
    getDiagnostics: vi.fn(() => Promise.resolve([])),
    getDocumentSymbols: vi.fn(() =>
      Promise.resolve({
        symbols: [
          { name: "myFunc", kind: "Function", line: 10, column: 1 },
          { name: "MyClass", kind: "Class", line: 20, column: 1 },
        ],
        count: 2,
        source: "lsp",
      }),
    ),
    findReferences: vi.fn(() =>
      Promise.resolve({
        found: true,
        references: [
          { file: "/tmp/a.ts", line: 5, column: 3 },
          { file: "/tmp/b.ts", line: 8, column: 1 },
        ],
        count: 2,
      }),
    ),
    ...overrides,
  };
}

describe("getChangeImpact", () => {
  it("returns extensionRequired when disconnected", async () => {
    const client = makeClient({ isConnected: vi.fn(() => false) });
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it("returns diagnostics only when no changedSymbols given", async () => {
    const client = makeClient({
      getDiagnostics: vi.fn(() =>
        Promise.resolve([
          {
            file: "/tmp/foo.ts",
            line: 1,
            column: 1,
            severity: "error",
            message: "Oops",
          },
          {
            file: "/tmp/foo.ts",
            line: 2,
            column: 1,
            severity: "warning",
            message: "Warn",
          },
        ]),
      ),
    });
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.diagnostics.errors).toBe(1);
    expect(data.diagnostics.warnings).toBe(1);
    expect(data.symbolImpact).toEqual([]);
    expect(client.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("finds references for named symbols", async () => {
    const client = makeClient();
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({
      filePath: "/tmp/foo.ts",
      changedSymbols: [{ name: "myFunc" }],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.symbolImpact).toHaveLength(1);
    expect(data.symbolImpact[0].name).toBe("myFunc");
    expect(data.symbolImpact[0].referenceCount).toBe(2);
    expect(data.symbolImpact[0].affectedFiles).toContain("/tmp/a.ts");
  });

  it("computes correct blast radius: low (<5 refs)", async () => {
    const client = makeClient();
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({
      filePath: "/tmp/foo.ts",
      changedSymbols: [{ name: "myFunc" }],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.blastRadius).toBe("low"); // 2 refs < 5
  });

  it("computes blast radius: high (≥20 refs)", async () => {
    const refs = Array.from({ length: 25 }, (_, i) => ({
      file: `/tmp/file${i}.ts`,
      line: 1,
      column: 1,
    }));
    const client = makeClient({
      findReferences: vi.fn(() =>
        Promise.resolve({ found: true, references: refs, count: refs.length }),
      ),
    });
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({
      filePath: "/tmp/foo.ts",
      changedSymbols: [{ name: "myFunc" }],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.blastRadius).toBe("high");
  });

  it("skips symbol not found in document symbols", async () => {
    const client = makeClient();
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({
      filePath: "/tmp/foo.ts",
      changedSymbols: [{ name: "nonExistent" }],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.symbolImpact).toHaveLength(0);
  });

  it("caps changedSymbols at 10 (via schema maxItems)", () => {
    const tool = createGetChangeImpactTool(workspace, makeClient() as never);
    expect(tool.schema.inputSchema.properties.changedSymbols.maxItems).toBe(10);
  });

  it("handles getDiagnostics failure gracefully", async () => {
    const client = makeClient({
      getDiagnostics: vi.fn(() => Promise.reject(new Error("extension gone"))),
    });
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.diagnostics.errors).toBe(0);
  });

  it("handles partial findReferences failure gracefully", async () => {
    const client = makeClient({
      findReferences: vi.fn(() => Promise.reject(new Error("timeout"))),
    });
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({
      filePath: "/tmp/foo.ts",
      changedSymbols: [{ name: "myFunc" }],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    // Should still return result, just with 0 refs for the failed symbol
    expect(data.symbolImpact[0].referenceCount).toBe(0);
  });

  it("includes summary string", async () => {
    const client = makeClient();
    const tool = createGetChangeImpactTool(workspace, client as never);
    const result = (await tool.handler({ filePath: "/tmp/foo.ts" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.summary).toBe("string");
    expect(data.summary.length).toBeGreaterThan(0);
  });
});
