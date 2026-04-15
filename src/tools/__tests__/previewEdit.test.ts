import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyLineRange,
  applySearchReplace,
  computeUnifiedDiff,
  createPreviewEditTool,
} from "../previewEdit.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function isError(r: { isError?: boolean }) {
  return r.isError === true;
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "preview-edit-"));
  fs.writeFileSync(
    path.join(workspace, "hello.ts"),
    "line1\nline2\nline3\nline4\nline5\n",
  );
  fs.writeFileSync(
    path.join(workspace, "greeting.ts"),
    "const x = 1;\nconst y = 2;\nconst z = x + y;\n",
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("computeUnifiedDiff", () => {
  it("returns empty diff for identical content", () => {
    const lines = ["a", "b", "c"];
    const result = computeUnifiedDiff(lines, lines, "file.ts");
    expect(result.diff).toBe("");
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });

  it("counts added and removed lines", () => {
    const orig = ["a", "b", "c"];
    const next = ["a", "X", "Y", "c"];
    const result = computeUnifiedDiff(orig, next, "file.ts");
    expect(result.linesAdded).toBe(2);
    expect(result.linesRemoved).toBe(1);
  });

  it("produces unified diff headers", () => {
    const orig = ["old line"];
    const next = ["new line"];
    const result = computeUnifiedDiff(orig, next, "test.ts");
    expect(result.diff).toContain("--- a/test.ts");
    expect(result.diff).toContain("+++ b/test.ts");
    expect(result.diff).toContain("@@");
    expect(result.diff).toContain("+new line");
    expect(result.diff).toContain("-old line");
  });

  it("handles empty original", () => {
    const result = computeUnifiedDiff([], ["new"], "f.ts");
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(0);
  });

  it("handles empty new content", () => {
    const result = computeUnifiedDiff(["gone"], [], "f.ts");
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(1);
  });
});

describe("applyLineRange", () => {
  it("replaces a single line", () => {
    const content = "a\nb\nc\n";
    expect(applyLineRange(content, 2, 2, "X")).toBe("a\nX\nc\n");
  });

  it("replaces multiple lines", () => {
    const content = "1\n2\n3\n4\n";
    expect(applyLineRange(content, 2, 3, "NEW")).toBe("1\nNEW\n4\n");
  });
});

describe("applySearchReplace", () => {
  it("replaces literal string", () => {
    expect(applySearchReplace("foo bar foo", "foo", "baz", false)).toBe(
      "baz bar baz",
    );
  });

  it("replaces with regex", () => {
    expect(applySearchReplace("hello world", "\\w+", "X", true)).toBe("X X");
  });

  it("case insensitive literal", () => {
    const result = applySearchReplace(
      "FOO foo Foo",
      "foo",
      "bar",
      false,
      false,
    );
    expect(result).toBe("bar bar bar");
  });
});

describe("createPreviewEditTool", () => {
  it("returns required output fields for lineRange", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = parse(
      await tool.handler({
        filePath: "hello.ts",
        operation: "lineRange",
        startLine: 2,
        endLine: 3,
        newContent: "replaced",
      }),
    );
    expect(typeof result.diff).toBe("string");
    expect(typeof result.linesAdded).toBe("number");
    expect(typeof result.linesRemoved).toBe("number");
    expect(Array.isArray(result.preview)).toBe(true);
  });

  it("returns diff for searchReplace operation", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = parse(
      await tool.handler({
        filePath: "greeting.ts",
        operation: "searchReplace",
        search: "const x = 1",
        replace: "const x = 99",
      }),
    );
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
    expect(result.diff).toContain("+const x = 99");
  });

  it("returns unchanged=true when no changes", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = parse(
      await tool.handler({
        filePath: "hello.ts",
        operation: "searchReplace",
        search: "DOES_NOT_EXIST",
        replace: "anything",
      }),
    );
    expect(result.unchanged).toBe(true);
    expect(result.linesAdded).toBe(0);
  });

  it("errors on non-existent file", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = await tool.handler({
      filePath: "missing.ts",
      operation: "lineRange",
      startLine: 1,
      endLine: 1,
      newContent: "x",
    });
    expect(isError(result)).toBe(true);
  });

  it("errors on invalid operation", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = await tool.handler({
      filePath: "hello.ts",
      operation: "invalid",
    });
    expect(isError(result)).toBe(true);
  });

  it("preview contains updated lines", async () => {
    const tool = createPreviewEditTool(workspace);
    const result = parse(
      await tool.handler({
        filePath: "hello.ts",
        operation: "lineRange",
        startLine: 1,
        endLine: 1,
        newContent: "FIRST",
      }),
    );
    expect(result.preview[0]).toBe("FIRST");
  });
});
