/**
 * Tests for editText.ts — applyEditsToContent (pure logic) and createEditTextTool
 * (native fs path; extension path tested via mock).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEditsToContent, createEditTextTool } from "../editText.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const disconnected = { isConnected: () => false } as any;

// ── applyEditsToContent (pure) ────────────────────────────────────────────────

describe("applyEditsToContent — insert", () => {
  it("inserts text at the start of a line", () => {
    const result = applyEditsToContent("hello\nworld\n", [
      { type: "insert", line: 1, column: 1, text: "// " },
    ]);
    expect(result).toBe("// hello\nworld\n");
  });

  it("inserts text in the middle of a line", () => {
    // column 5 → colIdx 4; before="foo ", after="bar"; result="foo baz bar"
    const result = applyEditsToContent("foo bar\n", [
      { type: "insert", line: 1, column: 5, text: "baz " },
    ]);
    expect(result).toBe("foo baz bar\n");
  });

  it("inserts multi-line text", () => {
    const result = applyEditsToContent("line1\nline3\n", [
      { type: "insert", line: 1, column: 6, text: "\nline2" },
    ]);
    expect(result).toBe("line1\nline2\nline3\n");
  });

  it("inserts at a line beyond EOF (pads with empty lines)", () => {
    const result = applyEditsToContent("line1\n", [
      { type: "insert", line: 5, column: 1, text: "end" },
    ]);
    expect(result).toContain("end");
  });

  it("applies multiple inserts in correct order (reverse processing)", () => {
    const result = applyEditsToContent("ABC\n", [
      { type: "insert", line: 1, column: 2, text: "1" },
      { type: "insert", line: 1, column: 3, text: "2" },
    ]);
    expect(result).toBe("A1B2C\n");
  });
});

describe("applyEditsToContent — delete", () => {
  it("deletes a range within a line", () => {
    // col 6 → idx 5; endCol 12 → afterText starts at idx 11 (past end of "hello world")
    // beforeText="hello", afterText="" → "hello\n"
    const result = applyEditsToContent("hello world\n", [
      { type: "delete", line: 1, column: 6, endLine: 1, endColumn: 12 },
    ]);
    expect(result).toBe("hello\n");
  });

  it("deletes across multiple lines", () => {
    const result = applyEditsToContent("line1\nline2\nline3\n", [
      { type: "delete", line: 1, column: 6, endLine: 2, endColumn: 6 },
    ]);
    expect(result).toBe("line1\nline3\n");
  });

  it("deletes entire line content when start/end span the line", () => {
    const result = applyEditsToContent("keep\ndelete me\nkeep\n", [
      { type: "delete", line: 2, column: 1, endLine: 2, endColumn: 10 },
    ]);
    expect(result).toBe("keep\n\nkeep\n");
  });

  it("clamps endLine beyond EOF to last line", () => {
    const result = applyEditsToContent("only line\n", [
      { type: "delete", line: 1, column: 5, endLine: 999, endColumn: 999 },
    ]);
    expect(result).toBe("only");
  });
});

describe("applyEditsToContent — replace", () => {
  it("replaces a single-line range with new text", () => {
    const result = applyEditsToContent("const foo = 1;\n", [
      {
        type: "replace",
        line: 1,
        column: 7,
        endLine: 1,
        endColumn: 10,
        text: "bar",
      },
    ]);
    expect(result).toBe("const bar = 1;\n");
  });

  it("replaces across lines with multi-line text", () => {
    const result = applyEditsToContent("start\nold\nend\n", [
      {
        type: "replace",
        line: 1,
        column: 6,
        endLine: 2,
        endColumn: 4,
        text: "\nnew",
      },
    ]);
    expect(result).toBe("start\nnew\nend\n");
  });

  it("replaces with empty string (acts as delete)", () => {
    const result = applyEditsToContent("remove me please\n", [
      {
        type: "replace",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 10,
        text: "",
      },
    ]);
    expect(result).toBe(" please\n");
  });
});

describe("applyEditsToContent — endLine/endColumn validation", () => {
  it("throws when delete is missing endColumn (regression: was silent no-op)", () => {
    // Regression: endColumn defaulted to column when undefined, producing a zero-width
    // range that silently deleted nothing instead of erroring.
    expect(() =>
      applyEditsToContent("hello world\n", [
        { type: "delete", line: 1, column: 3, endLine: 1 } as any,
      ]),
    ).toThrow(/endLine.*endColumn|endColumn.*endLine/i);
  });

  it("throws when replace is missing endLine", () => {
    expect(() =>
      applyEditsToContent("hello\n", [
        { type: "replace", line: 1, column: 1, endColumn: 3, text: "x" } as any,
      ]),
    ).toThrow(/endLine.*endColumn|endColumn.*endLine/i);
  });

  it("throws when endLine < line", () => {
    expect(() =>
      applyEditsToContent("line1\nline2\nline3\n", [
        { type: "delete", line: 3, column: 1, endLine: 1, endColumn: 5 },
      ]),
    ).toThrow(/endLine/i);
  });

  it("throws when endLine === line and endColumn < column", () => {
    expect(() =>
      applyEditsToContent("hello world\n", [
        {
          type: "replace",
          line: 1,
          column: 8,
          endLine: 1,
          endColumn: 3,
          text: "x",
        },
      ]),
    ).toThrow(/endColumn/i);
  });
});

describe("applyEditsToContent — overlap detection", () => {
  it("throws when two edits overlap on the same line", () => {
    expect(() =>
      applyEditsToContent("hello world\n", [
        { type: "delete", line: 1, column: 1, endLine: 1, endColumn: 8 },
        { type: "insert", line: 1, column: 5, text: "X" }, // inside first edit
      ]),
    ).toThrow(/overlapping/i);
  });

  it("throws when edit B starts before edit A ends (cross-line)", () => {
    expect(() =>
      applyEditsToContent("a\nb\nc\n", [
        { type: "delete", line: 1, column: 1, endLine: 2, endColumn: 2 },
        { type: "insert", line: 2, column: 1, text: "X" },
      ]),
    ).toThrow(/overlapping/i);
  });

  it("allows adjacent (non-overlapping) edits on same line", () => {
    const result = applyEditsToContent("ABCD\n", [
      { type: "insert", line: 1, column: 2, text: "1" },
      { type: "insert", line: 1, column: 3, text: "2" },
    ]);
    expect(result).toBe("A1B2CD\n");
  });
});

// ── createEditTextTool — validation ──────────────────────────────────────────

describe("createEditTextTool — input validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "edittext-")),
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns error when edits is empty array", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ filePath: "test.ts", edits: [] }),
    );
    expect(result.error).toMatch(/non-empty/i);
  });

  it("returns error when edits > 1000", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const edits = Array.from({ length: 1001 }, (_, i) => ({
      type: "insert",
      line: i + 1,
      column: 1,
      text: "x",
    }));
    const result = parse(await tool.handler({ filePath: "test.ts", edits }));
    expect(result.error).toMatch(/1000/);
  });

  it("returns error for invalid edit type", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "upsert", line: 1, column: 1, text: "x" }],
      }),
    );
    expect(result.error).toMatch(/insert.*delete.*replace/i);
  });

  it("returns error when insert missing text", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 1, column: 1 }],
      }),
    );
    expect(result.error).toMatch(/text.*required/i);
  });

  it("returns error when delete missing endLine/endColumn", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "delete", line: 1, column: 1 }],
      }),
    );
    expect(result.error).toMatch(/endLine.*required/i);
  });

  it("returns error when range is reversed", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [
          { type: "delete", line: 3, column: 1, endLine: 1, endColumn: 1 },
        ],
      }),
    );
    expect(result.error).toMatch(/cannot be reversed/i);
  });

  it("returns error when line < 1", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 0, column: 1, text: "x" }],
      }),
    );
    expect(result.error).toMatch(/must be >= 1/i);
  });
});

// ── createEditTextTool — native fs path ──────────────────────────────────────

describe("createEditTextTool — native fs (no extension)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "edittext-")),
    );
    filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("applies a single insert via native fs", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 1, column: 1, text: "// " }],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.source).toContain("native-fs");
    const written = fs.readFileSync(filePath, "utf-8");
    expect(written).toBe("// const x = 1;\nconst y = 2;\n");
  });

  it("applies a replace via native fs", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [
          {
            type: "replace",
            line: 1,
            column: 7,
            endLine: 1,
            endColumn: 8,
            text: "result",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    const written = fs.readFileSync(filePath, "utf-8");
    expect(written).toContain("const result = 1;");
  });

  it("returns error when file not found", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "nonexistent.ts",
        edits: [{ type: "insert", line: 1, column: 1, text: "x" }],
      }),
    );
    expect(result.error).toMatch(/not found/i);
  });

  it("returns error on overlapping edits (surfaces applyEditsToContent throw)", async () => {
    const tool = createEditTextTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [
          { type: "delete", line: 1, column: 1, endLine: 1, endColumn: 5 },
          { type: "insert", line: 1, column: 3, text: "X" },
        ],
      }),
    );
    expect(result.error).toMatch(/overlapping/i);
  });
});

// ── createEditTextTool — extension path ──────────────────────────────────────

describe("createEditTextTool — extension path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "edittext-ext-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "hello\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns extension result when connected and succeeds", async () => {
    const ext = {
      isConnected: () => true,
      editText: vi.fn().mockResolvedValue({ success: true, editsApplied: 1 }),
    } as any;
    const tool = createEditTextTool(tmpDir, ext);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 1, column: 1, text: "// " }],
      }),
    );
    expect(ext.editText).toHaveBeenCalledOnce();
    expect(result.source).toBe("vscode");
  });

  it("falls through to native-fs when extension returns null", async () => {
    const ext = {
      isConnected: () => true,
      editText: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createEditTextTool(tmpDir, ext);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 1, column: 1, text: "// " }],
      }),
    );
    expect(result.source).toContain("native-fs");
  });

  it("returns error when extension reports failure", async () => {
    const ext = {
      isConnected: () => true,
      editText: vi
        .fn()
        .mockResolvedValue({ success: false, error: "workspace closed" }),
    } as any;
    const tool = createEditTextTool(tmpDir, ext);
    const result = parse(
      await tool.handler({
        filePath: "test.ts",
        edits: [{ type: "insert", line: 1, column: 1, text: "x" }],
      }),
    );
    expect(result.error).toMatch(/workspace closed/i);
  });
});
