import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleGetSemanticTokens } from "../../handlers/semanticTokens";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

// Helper to build a Uint32Array from token groups
// Each group: [deltaLine, deltaStartChar, length, tokenTypeIndex, modifiersBitmask]
function makeTokenData(...groups: number[][]): Uint32Array {
  const flat = groups.flat();
  return new Uint32Array(flat);
}

const LEGEND = {
  tokenTypes: ["function", "variable", "class", "parameter"],
  tokenModifiers: ["declaration", "readonly", "deprecated"],
};

describe("handleGetSemanticTokens", () => {
  it("throws when file param is missing", async () => {
    await expect(handleGetSemanticTokens({})).rejects.toThrow(
      "file is required",
    );
  });

  it("returns unavailable message when legend is null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.tokens).toEqual([]);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("returns empty tokens when data is empty", async () => {
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND) // legend call
      .mockResolvedValueOnce({ data: new Uint32Array(0) }); // tokens call
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.tokens).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("decodes a single token correctly", async () => {
    // Token at line 3 (delta=2 from 0+1=1→line3), column 5 (delta=4), length=6, type=0 (function), modifiers=0b001 (declaration)
    const data = makeTokenData([2, 4, 6, 0, 0b001]);
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND)
      .mockResolvedValueOnce({ data });
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].line).toBe(3); // 0-based 2 → 1-based 3
    expect(result.tokens[0].column).toBe(5); // 0-based 4 → 1-based 5
    expect(result.tokens[0].length).toBe(6);
    expect(result.tokens[0].type).toBe("function");
    expect(result.tokens[0].modifiers).toContain("declaration");
  });

  it("decodes delta-encoded tokens across multiple lines", async () => {
    // Token 1: line 1, col 1, type=function
    // Token 2: line 1 still (delta=0), col 1+5=6, type=variable
    // Token 3: line 3 (delta=2), col 0, type=class
    const data = makeTokenData(
      [0, 0, 3, 0, 0], // line=0, col=0 → 1-based: line=1, col=1
      [0, 5, 2, 1, 0], // same line, col=0+5=5 → 1-based: col=6
      [2, 0, 4, 2, 0], // line=0+2=2, col=0 → 1-based: line=3, col=1
    );
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND)
      .mockResolvedValueOnce({ data });
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.tokens).toHaveLength(3);
    expect(result.tokens[0]).toMatchObject({
      line: 1,
      column: 1,
      type: "function",
    });
    expect(result.tokens[1]).toMatchObject({
      line: 1,
      column: 6,
      type: "variable",
    });
    expect(result.tokens[2]).toMatchObject({
      line: 3,
      column: 1,
      type: "class",
    });
  });

  it("filters by startLine and endLine", async () => {
    const data = makeTokenData(
      [0, 0, 1, 0, 0], // line=1
      [1, 0, 1, 1, 0], // line=2
      [1, 0, 1, 2, 0], // line=3
      [1, 0, 1, 3, 0], // line=4
    );
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND)
      .mockResolvedValueOnce({ data });
    const result = (await handleGetSemanticTokens({
      file: "/foo.ts",
      startLine: 2,
      endLine: 3,
    })) as any;
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0].line).toBe(2);
    expect(result.tokens[1].line).toBe(3);
  });

  it("caps output at maxTokens", async () => {
    const groups = Array.from({ length: 10 }, (_, i) => [
      i === 0 ? 0 : 1,
      0,
      1,
      0,
      0,
    ]);
    const data = makeTokenData(...groups);
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND)
      .mockResolvedValueOnce({ data });
    const result = (await handleGetSemanticTokens({
      file: "/foo.ts",
      maxTokens: 3,
    })) as any;
    expect(result.tokens).toHaveLength(3);
    expect(result.capped).toBe(true);
  });

  it("sanitizes legend entries (truncates long names)", async () => {
    const longName = "a".repeat(200);
    const legend = { tokenTypes: [longName], tokenModifiers: [] };
    const data = makeTokenData([0, 0, 1, 0, 0]);
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(legend)
      .mockResolvedValueOnce({ data });
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.legend.tokenTypes[0].length).toBeLessThanOrEqual(64);
  });

  it("caps legend at 50 entries", async () => {
    const legend = {
      tokenTypes: Array.from({ length: 100 }, (_, i) => `type${i}`),
      tokenModifiers: [],
    };
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(legend)
      .mockResolvedValueOnce({ data: new Uint32Array(0) });
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.legend.tokenTypes).toHaveLength(50);
  });

  it("returns error message when tokens command throws", async () => {
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce(LEGEND)
      .mockRejectedValueOnce(new Error("provider failed"));
    const result = (await handleGetSemanticTokens({ file: "/foo.ts" })) as any;
    expect(result.tokens).toEqual([]);
    expect(result.message).toMatch(/failed/i);
  });
});
