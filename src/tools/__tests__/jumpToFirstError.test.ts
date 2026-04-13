import { describe, expect, it, vi } from "vitest";
import { createJumpToFirstErrorTool } from "../jumpToFirstError.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeGetDiagnostics(
  diagnostics: Array<Record<string, unknown>>,
  isError = false,
) {
  return {
    schema: { name: "getDiagnostics" } as never,
    handler: vi.fn(async () => {
      if (isError) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }],
          isError: true as const,
        };
      }
      const data = { available: true, source: "extension", diagnostics };
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      };
    }),
  } as never;
}

function makeOpenFile() {
  const handler = vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ opened: true }) }],
    structuredContent: { opened: true },
  }));
  return { schema: { name: "openFile" } as never, handler } as never;
}

function makeSetDecorations(isError = false) {
  const handler = vi.fn(async () => {
    if (isError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "fail" }) }],
        isError: true as const,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ applied: 1 }) }],
      structuredContent: { applied: 1 },
    };
  });
  return {
    schema: { name: "setEditorDecorations" } as never,
    handler,
  } as never;
}

function makeExtClient(connected: boolean) {
  return { isConnected: () => connected } as never;
}

describe("createJumpToFirstErrorTool", () => {
  it("returns { found: false } when there are no errors and does not call openFile", async () => {
    const getDiagnostics = makeGetDiagnostics([]);
    const openFile = makeOpenFile();
    const tool = createJumpToFirstErrorTool({ getDiagnostics, openFile });
    const data = parse(await tool.handler({}));
    expect(data.found).toBe(false);
    expect(openFile.handler).not.toHaveBeenCalled();
  });

  it("returns { found: true } and calls openFile with normalized path on file:// URL", async () => {
    const getDiagnostics = makeGetDiagnostics([
      {
        file: "file:///workspace/src/app.ts",
        severity: "error",
        message: "Type mismatch",
        line: 42,
        column: 5,
        rule: "TS2322",
      },
    ]);
    const openFile = makeOpenFile();
    const setEditorDecorations = makeSetDecorations();
    const extensionClient = makeExtClient(true);
    const tool = createJumpToFirstErrorTool({
      getDiagnostics,
      openFile,
      setEditorDecorations,
      extensionClient,
    });
    const data = parse(await tool.handler({}));
    expect(data.found).toBe(true);
    expect(data.file).toBe("/workspace/src/app.ts"); // stripped file://
    expect(data.line).toBe(42);
    expect(data.column).toBe(5);
    expect(data.message).toBe("Type mismatch");
    expect(data.rule).toBe("TS2322");
    expect(data.decorationApplied).toBe(true);
    expect(openFile.handler).toHaveBeenCalledWith({
      filePath: "/workspace/src/app.ts",
      startLine: 42,
    });
    expect(setEditorDecorations.handler).toHaveBeenCalledOnce();
  });

  it("uses relative file path unchanged (CLI linter format)", async () => {
    const getDiagnostics = makeGetDiagnostics([
      {
        file: "src/foo.ts",
        severity: "error",
        message: "Unused variable",
        line: 7,
        column: 1,
      },
    ]);
    const openFile = makeOpenFile();
    const tool = createJumpToFirstErrorTool({ getDiagnostics, openFile });
    const data = parse(await tool.handler({}));
    expect(data.found).toBe(true);
    expect(data.file).toBe("src/foo.ts");
    expect(openFile.handler).toHaveBeenCalledWith({
      filePath: "src/foo.ts",
      startLine: 7,
    });
  });

  it("skips decoration when extension is disconnected", async () => {
    const getDiagnostics = makeGetDiagnostics([
      {
        file: "src/foo.ts",
        severity: "error",
        message: "Boom",
        line: 1,
      },
    ]);
    const openFile = makeOpenFile();
    const setEditorDecorations = makeSetDecorations();
    const extensionClient = makeExtClient(false);
    const tool = createJumpToFirstErrorTool({
      getDiagnostics,
      openFile,
      setEditorDecorations,
      extensionClient,
    });
    const data = parse(await tool.handler({}));
    expect(data.found).toBe(true);
    expect(data.decorationApplied).toBe(false);
    expect(setEditorDecorations.handler).not.toHaveBeenCalled();
  });

  it("propagates getDiagnostics errors", async () => {
    const getDiagnostics = makeGetDiagnostics([], true);
    const openFile = makeOpenFile();
    const tool = createJumpToFirstErrorTool({ getDiagnostics, openFile });
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(openFile.handler).not.toHaveBeenCalled();
  });

  it("decoration failure does not fail the jump", async () => {
    const getDiagnostics = makeGetDiagnostics([
      {
        file: "src/foo.ts",
        severity: "error",
        message: "Boom",
        line: 1,
      },
    ]);
    const openFile = makeOpenFile();
    const setEditorDecorations = makeSetDecorations(true);
    const extensionClient = makeExtClient(true);
    const tool = createJumpToFirstErrorTool({
      getDiagnostics,
      openFile,
      setEditorDecorations,
      extensionClient,
    });
    const data = parse(await tool.handler({}));
    expect(data.found).toBe(true);
    expect(data.decorationApplied).toBe(false);
  });
});
