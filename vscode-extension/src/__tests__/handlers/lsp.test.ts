import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { __reset, Uri, Position, Range, WorkspaceEdit } from "../__mocks__/vscode";
import { createLspHandlers } from "../../handlers/lsp";

let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

beforeEach(() => {
  __reset();
  handlers = createLspHandlers({ log: vi.fn() });
});

// ── goToDefinition ────────────────────────────────────────────

describe("goToDefinition", () => {
  const call = (params: Record<string, unknown>) => handlers["extension/goToDefinition"](params);

  it("returns locations for Location[] result", async () => {
    const loc = { uri: Uri.file("/def.ts"), range: new Range(9, 4, 9, 10) };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([loc]);

    const result = (await call({ file: "/test.ts", line: 5, column: 3 })) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("/def.ts");
    expect(result[0].line).toBe(10);   // 9 + 1
    expect(result[0].column).toBe(5);  // 4 + 1
  });

  it("returns locations for LocationLink[] result", async () => {
    const link = {
      targetUri: Uri.file("/target.ts"),
      targetRange: new Range(0, 0, 0, 5),
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([link]);

    const result = (await call({ file: "/test.ts", line: 1, column: 1 })) as any[];
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
  const call = (params: Record<string, unknown>) => handlers["extension/findReferences"](params);

  it("returns references", async () => {
    const loc = { uri: Uri.file("/a.ts"), range: new Range(2, 0, 2, 5) };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([loc]);

    const result = (await call({ file: "/test.ts", line: 1, column: 1 })) as any;
    expect(result.count).toBe(1);
    expect(result.references[0].file).toBe("/a.ts");
    expect(result.references[0].line).toBe(3);
  });

  it("returns empty references when none found", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({ file: "/test.ts", line: 1, column: 1 })) as any;
    expect(result.references).toEqual([]);
  });
});

// ── getHover ──────────────────────────────────────────────────

describe("getHover", () => {
  const call = (params: Record<string, unknown>) => handlers["extension/getHover"](params);

  it("returns hover contents", async () => {
    const hover = {
      contents: [{ value: "function foo(): void" }, "some docs"],
      range: new Range(0, 0, 0, 3),
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([hover]);

    const result = (await call({ file: "/test.ts", line: 1, column: 1 })) as any;
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
  const call = (params: Record<string, unknown>) => handlers["extension/getCodeActions"](params);

  it("returns code actions", async () => {
    const action = { title: "Fix import", kind: { value: "quickfix" }, isPreferred: true };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({
      file: "/test.ts",
      startLine: 1, startColumn: 1, endLine: 1, endColumn: 5,
    })) as any;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].title).toBe("Fix import");
    expect(result.actions[0].isPreferred).toBe(true);
  });

  it("returns empty when no actions", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({
      file: "/test.ts",
      startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
    })) as any;
    expect(result.actions).toEqual([]);
  });
});

// ── applyCodeAction ───────────────────────────────────────────

describe("applyCodeAction", () => {
  const call = (params: Record<string, unknown>) => handlers["extension/applyCodeAction"](params);
  const baseParams = { file: "/test.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 };

  it("applies action with edit", async () => {
    const edit = new WorkspaceEdit();
    const action = { title: "Fix it", edit, command: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({ ...baseParams, actionTitle: "Fix it" })) as any;
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
      .mockResolvedValueOnce([action])  // getCodeActions
      .mockResolvedValueOnce(undefined); // executeCommand

    const result = (await call({ ...baseParams, actionTitle: "Run fix" })) as any;
    expect(result.applied).toBe(true);
    expect(result.command).toBe("editor.fix");
  });

  it("returns error when action not found", async () => {
    const action = { title: "Other", edit: undefined };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([action]);

    const result = (await call({ ...baseParams, actionTitle: "Missing" })) as any;
    expect(result.applied).toBe(false);
    expect(result.available).toContain("Other");
  });

  it("returns error when no actions available", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await call({ ...baseParams, actionTitle: "Fix" })) as any;
    expect(result.applied).toBe(false);
  });
});

// ── renameSymbol ──────────────────────────────────────────────

describe("renameSymbol", () => {
  const call = (params: Record<string, unknown>) => handlers["extension/renameSymbol"](params);

  it("renames symbol successfully", async () => {
    const edit = new WorkspaceEdit();
    const uri = Uri.file("/test.ts");
    (edit as any).__entries = [[uri, [{}, {}]]]; // 2 edits in 1 file
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(edit);

    const result = (await call({ file: "/test.ts", line: 5, column: 3, newName: "bar" })) as any;
    expect(result.success).toBe(true);
    expect(result.newName).toBe("bar");
    expect(result.affectedFiles).toHaveLength(1);
    expect(result.totalEdits).toBe(2);
  });

  it("returns error when rename not supported", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await call({ file: "/test.ts", line: 1, column: 1, newName: "x" })) as any;
    expect(result.success).toBe(false);
  });

  it("returns error when no edits generated", async () => {
    const edit = new WorkspaceEdit();
    (edit as any).__entries = [];
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(edit);

    const result = (await call({ file: "/test.ts", line: 1, column: 1, newName: "x" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("No edits");
  });
});

// ── searchSymbols ─────────────────────────────────────────────

describe("searchSymbols", () => {
  const call = (params: Record<string, unknown>) => handlers["extension/searchSymbols"](params);

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
});
