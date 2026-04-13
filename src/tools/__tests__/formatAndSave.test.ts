import { describe, expect, it, vi } from "vitest";
import { createFormatAndSaveTool } from "../formatAndSave.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeFormatDoc(result: Record<string, unknown> | { isError: true }) {
  return {
    schema: { name: "formatDocument" } as never,
    handler: vi.fn(async () => {
      if ("isError" in result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "format failed" }) },
          ],
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }),
  } as never;
}

function makeSaveDoc(result: Record<string, unknown> | { isError: true }) {
  return {
    schema: { name: "saveDocument" } as never,
    handler: vi.fn(async () => {
      if ("isError" in result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "save failed" }) },
          ],
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }),
  } as never;
}

describe("createFormatAndSaveTool", () => {
  it("happy path: formats and saves, returns combined result", async () => {
    const formatDocument = makeFormatDoc({
      formatted: true,
      source: "extension",
      changes: "modified",
      linesBeforeCount: 10,
      linesAfterCount: 11,
    });
    const saveDocument = makeSaveDoc({
      success: true,
      saved: true,
      source: "vscode-buffer",
    });
    const tool = createFormatAndSaveTool({ formatDocument, saveDocument });
    const result = await tool.handler({ filePath: "/ws/a.ts" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.formatted).toBe(true);
    expect(data.changes).toBe("modified");
    expect(data.saved).toBe(true);
    expect(data.source).toBe("vscode-buffer");
    expect(data.linesBeforeCount).toBe(10);
    expect(data.linesAfterCount).toBe(11);
    expect(formatDocument.handler).toHaveBeenCalledWith(
      { filePath: "/ws/a.ts" },
      undefined,
      undefined,
    );
    expect(saveDocument.handler).toHaveBeenCalledWith({ filePath: "/ws/a.ts" });
  });

  it("propagates formatter errors; save is NOT called", async () => {
    const formatDocument = makeFormatDoc({ isError: true });
    const saveDocument = makeSaveDoc({ success: true, saved: true });
    const tool = createFormatAndSaveTool({ formatDocument, saveDocument });
    const result = await tool.handler({ filePath: "/ws/a.ts" });
    expect(result.isError).toBe(true);
    expect(saveDocument.handler).not.toHaveBeenCalled();
  });

  it("propagates save errors after a successful format", async () => {
    const formatDocument = makeFormatDoc({
      formatted: true,
      source: "extension",
      changes: "none",
    });
    const saveDocument = makeSaveDoc({ isError: true });
    const tool = createFormatAndSaveTool({ formatDocument, saveDocument });
    const result = await tool.handler({ filePath: "/ws/a.ts" });
    expect(result.isError).toBe(true);
    expect(formatDocument.handler).toHaveBeenCalledOnce();
  });

  it("falls back to CLI format + native save — coherent combined shape", async () => {
    const formatDocument = makeFormatDoc({
      formatted: true,
      source: "cli",
      changes: "modified",
    });
    const saveDocument = makeSaveDoc({
      success: true,
      saved: false,
      message: "File is not open in VS Code editor",
    });
    const tool = createFormatAndSaveTool({ formatDocument, saveDocument });
    const data = parse(await tool.handler({ filePath: "/ws/a.ts" }));
    expect(data.formatted).toBe(true);
    expect(data.saved).toBe(false);
    expect(data.source).toBe("cli");
    expect(data.message).toBe("File is not open in VS Code editor");
  });
});
