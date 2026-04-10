import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleGetInlayHints } from "../../handlers/inlayHints";
import { __reset, Position } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function makeHint(
  line: number,
  character: number,
  label: string | Array<{ value: string }>,
  kind?: number,
  tooltip?: string,
) {
  return {
    position: new Position(line, character),
    label,
    kind,
    tooltip,
  };
}

describe("handleGetInlayHints", () => {
  it("throws when file param is missing", async () => {
    await expect(
      handleGetInlayHints({ startLine: 1, endLine: 10 }),
    ).rejects.toThrow("file is required");
  });

  it("throws when startLine param is missing", async () => {
    await expect(
      handleGetInlayHints({ file: "/foo.ts", endLine: 10 }),
    ).rejects.toThrow("startLine is required");
  });

  it("throws when endLine param is missing", async () => {
    await expect(
      handleGetInlayHints({ file: "/foo.ts", startLine: 1 }),
    ).rejects.toThrow("endLine is required");
  });

  it("throws when endLine is less than startLine", async () => {
    await expect(
      handleGetInlayHints({ file: "/foo.ts", startLine: 10, endLine: 5 }),
    ).rejects.toThrow("endLine must be >= startLine");
  });

  it("returns {hints:[], count:0, message} when executeCommand throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("provider not available"),
    );
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("returns {hints:[], count:0} when result is null", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns {hints:[], count:0} when result is empty array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("serializes hint with string label and converts to 1-based position", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(4, 7, ": string"),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0].position.line).toBe(5); // 4 + 1
    expect(result.hints[0].position.column).toBe(8); // 7 + 1
    expect(result.hints[0].label).toBe(": string");
    expect(result.count).toBe(1);
  });

  it("serializes hint with LabelPart array (joins values)", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(0, 0, [{ value: "param" }, { value: ":" }]),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints[0].label).toBe("param:");
  });

  it("maps kind=1 (Type) to 'type'", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(0, 0, ": number", vscode.InlayHintKind.Type),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints[0].kind).toBe("type");
  });

  it("maps kind=2 (Parameter) to 'parameter'", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(0, 0, "name:", vscode.InlayHintKind.Parameter),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints[0].kind).toBe("parameter");
  });

  it("maps unknown kind to 'other'", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(0, 0, "hint", 99),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints[0].kind).toBe("other");
  });

  it("includes tooltip when it is a string", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      makeHint(0, 0, "hint", undefined, "This is a tooltip"),
    ]);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints[0].tooltip).toBe("This is a tooltip");
  });

  it("sets capped=true and truncates at MAX_HINTS (500)", async () => {
    const manyHints = Array.from({ length: 600 }, (_, i) =>
      makeHint(i, 0, `hint${i}`),
    );
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(manyHints);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 700,
    })) as any;
    expect(result.hints).toHaveLength(500);
    expect(result.count).toBe(600);
    expect(result.capped).toBe(true);
  });

  it("sets capped=false when hints count is at or under MAX_HINTS", async () => {
    const hints = Array.from({ length: 10 }, (_, i) =>
      makeHint(i, 0, `hint${i}`),
    );
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(hints);
    const result = (await handleGetInlayHints({
      file: "/foo.ts",
      startLine: 1,
      endLine: 20,
    })) as any;
    expect(result.capped).toBe(false);
  });
});
