import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createLspHandlers } from "../../handlers/lsp";
import { __reset, Range, Uri, WorkspaceEdit } from "../__mocks__/vscode";

let handlers: Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown>
>;

beforeEach(() => {
  __reset();
  handlers = createLspHandlers({ log: vi.fn() });
});

// ── goToDefinition ────────────────────────────────────────────

describe("goToDefinition", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/goToDefinition"](params);

  it("returns locations for Location[] result", async () => {
    const loc = { uri: Uri.file("/def.ts"), range: new Range(9, 4, 9, 10) };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([loc]);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
    })) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("/def.ts");
    expect(result[0].line).toBe(10); // 9 + 1
    expect(result[0].column).toBe(5); // 4 + 1
  });

  it("returns locations for LocationLink[] result", async () => {
    const link = {
      targetUri: Uri.file("/target.ts"),
      targetRange: new Range(0, 0, 0, 5),
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([link]);

    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
    })) as any[];
    expect(result[0].file).toBe("/target.ts");
  });

  it("returns null when no definitions found", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    expect(await call({ file: "/test.ts", line: 1, column: 1 })).toBeNull();
  });

  it("returns null when result is null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    expect(await call({ file: "/test.ts", line: 1, column: 1 })).toBeNull();
  });

  it("throws on missing file param", async () => {
    await expect(call({ line: 1, column: 1 })).rejects.toThrow("file");
  });

  it("throws on missing line param", async () => {
    await expect(call({ file: "/test.ts", column: 1 })).rejects.toThrow("line");
  });
});

// ── findReferences ────────────────────────────────────────────

describe("findReferences", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/findReferences"](params);

  it("returns references", async () => {
    const loc = { uri: Uri.file("/a.ts"), range: new Range(2, 0, 2, 5) };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([loc]);

    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.count).toBe(1);
    expect(result.references[0].file).toBe("/a.ts");
    expect(result.references[0].line).toBe(3);
  });

  it("returns empty references when none found", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.references).toEqual([]);
  });

  it("returns empty references when result is null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.references).toEqual([]);
  });
});

// ── getHover ──────────────────────────────────────────────────

describe("getHover", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/getHover"](params);

  it("returns hover contents", async () => {
    const hover = {
      contents: [{ value: "function foo(): void" }, "some docs"],
      range: new Range(0, 0, 0, 3),
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([hover]);

    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.contents).toEqual(["function foo(): void", "some docs"]);
    expect(result.range).toBeDefined();
  });

  it("returns null when no hover", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    expect(await call({ file: "/test.ts", line: 1, column: 1 })).toBeNull();
  });
});

// ── getCodeActions ────────────────────────────────────────────

describe("getCodeActions", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/getCodeActions"](params);

  it("returns code actions", async () => {
    const action = {
      title: "Fix import",
      kind: { value: "quickfix" },
      isPreferred: true,
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({
      file: "/test.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 5,
    })) as any;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].title).toBe("Fix import");
    expect(result.actions[0].isPreferred).toBe(true);
  });

  it("returns empty when no actions", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({
      file: "/test.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    })) as any;
    expect(result.actions).toEqual([]);
  });
});

// ── applyCodeAction ───────────────────────────────────────────

describe("applyCodeAction", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/applyCodeAction"](params);
  const baseParams = {
    file: "/test.ts",
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 5,
  };

  it("applies action with edit", async () => {
    const edit = new WorkspaceEdit();
    const action = { title: "Fix it", edit, command: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({
      ...baseParams,
      actionTitle: "Fix it",
    })) as any;
    expect(result.applied).toBe(true);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledWith(edit);
  });

  it("applies action with command", async () => {
    const action = {
      title: "Run fix",
      edit: undefined,
      command: { command: "editor.fix", arguments: ["arg1"] },
    };
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([action]) // getCodeActions
      .mockResolvedValueOnce(undefined); // executeCommand

    const result = (await call({
      ...baseParams,
      actionTitle: "Run fix",
    })) as any;
    expect(result.applied).toBe(true);
    expect(result.command).toBe("editor.fix");
  });

  it("returns error when action not found", async () => {
    const action = { title: "Other", edit: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({
      ...baseParams,
      actionTitle: "Missing",
    })) as any;
    expect(result.applied).toBe(false);
    expect(result.available).toContain("Other");
  });

  it("returns error when no actions available", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({ ...baseParams, actionTitle: "Fix" })) as any;
    expect(result.applied).toBe(false);
  });

  it("returns applied:false when applyEdit returns false", async () => {
    const edit = new WorkspaceEdit();
    const action = { title: "Fix it", edit, command: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false);

    const result = (await call({
      ...baseParams,
      actionTitle: "Fix it",
    })) as any;
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/Failed to apply/);
  });
});

// ── renameSymbol ──────────────────────────────────────────────

describe("renameSymbol", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/renameSymbol"](params);

  it("renames symbol successfully", async () => {
    const edit = new WorkspaceEdit();
    const uri = Uri.file("/test.ts");
    (edit as any).__entries = [[uri, [{}, {}]]]; // 2 edits in 1 file
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(edit);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
      newName: "bar",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.newName).toBe("bar");
    expect(result.affectedFiles).toHaveLength(1);
    expect(result.totalEdits).toBe(2);
  });

  it("returns error when rename not supported", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
      newName: "x",
    })) as any;
    expect(result.success).toBe(false);
  });

  it("returns error when no edits generated", async () => {
    const edit = new WorkspaceEdit();
    (edit as any).__entries = [];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(edit);

    const result = (await call({
      file: "/test.ts",
      line: 1,
      column: 1,
      newName: "x",
    })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("No edits");
  });

  it("throws when newName is missing", async () => {
    await expect(
      call({ file: "/test.ts", line: 1, column: 1 }),
    ).rejects.toThrow("newName");
  });
});

// ── getDocumentSymbols ────────────────────────────────────────

describe("getDocumentSymbols", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/getDocumentSymbols"](params);

  function makeDocSym(
    name: string,
    kind: number,
    startLine: number,
    endLine: number,
    children: any[] = [],
    detail = "",
  ): any {
    return {
      name,
      kind,
      detail,
      range: new Range(startLine, 0, endLine, 0),
      selectionRange: new Range(startLine, 0, startLine, name.length),
      children,
    };
  }

  it("returns empty when no symbols", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = (await call({ file: "/test.ts" })) as any;
    expect(result).toEqual({ symbols: [], count: 0 });
  });

  it("flattens top-level symbols with 1-based lines", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeDocSym("myFn", 11 /* Function */, 4, 10),
    ]);
    const result = (await call({ file: "/test.ts" })) as any;
    expect(result.count).toBe(1);
    expect(result.symbols[0]).toMatchObject({
      name: "myFn",
      kind: "Function",
      line: 5,
      endLine: 11,
      parent: null,
    });
  });

  it("flattens nested children with parent name", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeDocSym("MyClass", 4 /* Class */, 0, 20, [
        makeDocSym("myMethod", 5 /* Method */, 2, 8),
      ]),
    ]);
    const result = (await call({ file: "/test.ts" })) as any;
    expect(result.count).toBe(2);
    expect(result.symbols[0]).toMatchObject({ name: "MyClass", parent: null });
    expect(result.symbols[1]).toMatchObject({
      name: "myMethod",
      parent: "MyClass",
    });
  });

  it("includes detail when present, null when absent", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeDocSym("x", 12 /* Variable */, 0, 0, [], "string"),
      makeDocSym("y", 12, 1, 1, [], ""),
    ]);
    const result = (await call({ file: "/test.ts" })) as any;
    expect(result.symbols[0].detail).toBe("string");
    expect(result.symbols[1].detail).toBeNull();
  });

  it("flattens three-level hierarchy with correct intermediate parent names", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeDocSym("MyClass", 4 /* Class */, 0, 30, [
        makeDocSym("myMethod", 5 /* Method */, 2, 20, [
          makeDocSym("innerLambda", 11 /* Function */, 5, 8),
        ]),
      ]),
    ]);
    const result = (await call({ file: "/test.ts" })) as any;
    expect(result.count).toBe(3);
    expect(result.symbols[0]).toMatchObject({ name: "MyClass", parent: null });
    expect(result.symbols[1]).toMatchObject({
      name: "myMethod",
      parent: "MyClass",
    });
    expect(result.symbols[2]).toMatchObject({
      name: "innerLambda",
      parent: "myMethod", // parent is immediate parent, not grandparent
    });
  });

  it("throws when file missing", async () => {
    await expect(call({})).rejects.toThrow("file");
  });
});

// ── getCallHierarchy ──────────────────────────────────────────

describe("getCallHierarchy", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/getCallHierarchy"](params);

  function makeItem(name: string, kind: number, file: string, line: number) {
    return {
      name,
      kind,
      detail: "",
      uri: Uri.file(file),
      range: new Range(line - 1, 0, line - 1, name.length),
      selectionRange: new Range(line - 1, 0, line - 1, name.length),
    };
  }

  it("returns null when prepareCallHierarchy returns nothing", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    expect(await call({ file: "/test.ts", line: 5, column: 3 })).toBeNull();
  });

  it("returns null for empty items array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    expect(await call({ file: "/test.ts", line: 5, column: 3 })).toBeNull();
  });

  it("returns symbol with incoming and outgoing by default", async () => {
    const root = makeItem("myFn", 11, "/test.ts", 5);
    const caller = makeItem("caller", 11, "/bar.ts", 10);
    const callee = makeItem("callee", 11, "/baz.ts", 3);

    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([
        { from: caller, fromRanges: [new Range(9, 2, 9, 8)] },
      ])
      .mockResolvedValueOnce([
        { to: callee, fromRanges: [new Range(4, 0, 4, 6)] },
      ]);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.symbol.name).toBe("myFn");
    expect(result.symbol.kind).toBe("Function");
    expect(result.symbol.file).toBe("/test.ts");
    // selectionRange.start is line 4 (0-based) → line 5 (1-based), char 0 → col 1
    expect(result.symbol.line).toBe(5);
    expect(result.symbol.column).toBe(1);
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].name).toBe("caller");
    expect(result.incoming[0].callSites[0]).toEqual({ line: 10, column: 3 });
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0].name).toBe("callee");
  });

  it("only fetches incoming when direction=incoming", async () => {
    const root = makeItem("myFn", 11, "/test.ts", 5);
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([]);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
      direction: "incoming",
    })) as any;
    expect(result.incoming).toEqual([]);
    expect(result.outgoing).toBeUndefined();
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("only fetches outgoing when direction=outgoing", async () => {
    const root = makeItem("myFn", 11, "/test.ts", 5);
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([]);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
      direction: "outgoing",
    })) as any;
    expect(result.incoming).toBeUndefined();
    expect(result.outgoing).toEqual([]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("truncates results to maxResults", async () => {
    const root = makeItem("myFn", 11, "/test.ts", 5);
    const manyCallers = Array.from({ length: 20 }, (_, i) => ({
      from: makeItem(`caller${i}`, 11, "/bar.ts", i + 1),
      fromRanges: [new Range(i, 0, i, 3)],
    }));
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce(manyCallers)
      .mockResolvedValueOnce([]);

    const result = (await call({
      file: "/test.ts",
      line: 5,
      column: 3,
      maxResults: 5,
    })) as any;
    expect(result.incoming).toHaveLength(5);
  });

  it("throws when file missing", async () => {
    await expect(call({ line: 1, column: 1 })).rejects.toThrow("file");
  });
});

// ── searchSymbols ─────────────────────────────────────────────

describe("searchSymbols", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/searchSymbols"](params);

  it("returns symbols", async () => {
    const sym = {
      name: "MyClass",
      kind: 4, // Class
      location: { uri: Uri.file("/cls.ts"), range: new Range(0, 0, 0, 7) },
      containerName: "module",
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([sym]);

    const result = (await call({ query: "MyClass" })) as any;
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe("MyClass");
    expect(result.symbols[0].kind).toBe("Class");
    expect(result.symbols[0].file).toBe("/cls.ts");
    expect(result.count).toBe(1);
  });

  it("returns empty when no symbols", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({ query: "nope" })) as any;
    expect(result.symbols).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("truncates at maxResults", async () => {
    const syms = Array.from({ length: 10 }, (_, i) => ({
      name: `sym${i}`,
      kind: 11,
      location: { uri: Uri.file("/f.ts"), range: new Range(i, 0, i, 3) },
      containerName: "",
    }));
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(syms);

    const result = (await call({ query: "sym", maxResults: 3 })) as any;
    expect(result.symbols).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("returns empty result when executeCommand throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("symbol provider failed"),
    );
    const result = (await call({ query: "foo" })) as any;
    expect(result.symbols).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ── goToDefinition throw path ──────────────────────────────────

describe("goToDefinition — executeCommand throw path", () => {
  const call = (params: Record<string, unknown>) =>
    handlers["extension/goToDefinition"](params);

  it("returns null when executeCommand throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("definition provider error"),
    );
    const result = await call({ file: "/test.ts", line: 1, column: 1 });
    expect(result).toBeNull();
  });
});
