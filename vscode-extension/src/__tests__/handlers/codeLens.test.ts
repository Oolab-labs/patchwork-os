import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleGetCodeLens } from "../../handlers/codeLens";
import { __reset, Range } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function makeLens(startLine: number, startChar: number, title: string | null) {
  return {
    range: new Range(startLine, startChar, startLine, startChar + 10),
    command:
      title !== null
        ? { title, command: "some.command", arguments: [] }
        : undefined,
  };
}

describe("handleGetCodeLens", () => {
  it("throws when file param is missing", async () => {
    await expect(handleGetCodeLens({})).rejects.toThrow("file is required");
  });

  it("returns empty lenses when provider returns null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns empty lenses when provider returns empty array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses).toEqual([]);
  });

  it("serializes lenses with 1-based line/column", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeLens(4, 0, "3 references"),
    ]);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses).toHaveLength(1);
    expect(result.lenses[0].line).toBe(5); // 4 + 1
    expect(result.lenses[0].column).toBe(1); // 0 + 1
    expect(result.lenses[0].command).toBe("3 references");
    expect(result.count).toBe(1);
  });

  it("omits commandId from output", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeLens(0, 0, "Run Test"),
    ]);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses[0].commandId).toBeUndefined();
  });

  it("handles lens with no command (unresolved)", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeLens(0, 0, null),
    ]);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses[0].command).toBeNull();
  });

  it("truncates command titles longer than 200 chars", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeLens(0, 0, "x".repeat(300)),
    ]);
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses[0].command.length).toBeLessThanOrEqual(200);
  });

  it("returns unavailable message when provider throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("no provider"),
    );
    const result = (await handleGetCodeLens({ file: "/foo.ts" })) as any;
    expect(result.lenses).toEqual([]);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("calls executeCodeLensProvider with itemResolveCount=100", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    await handleGetCodeLens({ file: "/foo.ts" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.executeCodeLensProvider",
      expect.anything(),
      100,
    );
  });
});
