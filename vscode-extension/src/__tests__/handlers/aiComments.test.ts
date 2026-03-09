import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { __reset, _mockTextDocument, Uri } from "../__mocks__/vscode";
import {
  scanDocumentForAIComments,
  scanAllOpenDocuments,
  invalidateDocumentCache,
  handleGetAIComments,
} from "../../handlers/aiComments";

function makeDocWithLines(lines: string[], fsPath = "/workspace/file.ts") {
  return _mockTextDocument({
    fsPath,
    lineCount: lines.length,
    lineAt: (n: number) => ({ text: lines[n] ?? "" }),
  });
}

beforeEach(() => {
  __reset();
  // Clear the module-level cache by invalidating all known URIs
  invalidateDocumentCache("file:///workspace/file.ts");
  invalidateDocumentCache("file:///workspace/other.ts");
});

describe("scanDocumentForAIComments", () => {
  it("detects // AI: comments", () => {
    const doc = makeDocWithLines(["const x = 1;", "// AI: FIX: memory leak here"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("fix");
    expect(results[0].comment).toBe("memory leak here");
    expect(results[0].line).toBe(2);
    expect(results[0].syntax).toBe("//");
  });

  it("detects # AI: comments", () => {
    const doc = makeDocWithLines(["# AI: TODO: add tests"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("todo");
    expect(results[0].syntax).toBe("#");
  });

  it("detects /* AI: */ comments", () => {
    const doc = makeDocWithLines(["/* AI: WARN: deprecated */", "code()"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("warn");
    expect(results[0].syntax).toBe("/* */");
  });

  it("detects <!-- AI: --> comments", () => {
    const doc = makeDocWithLines(["<!-- AI: QUESTION: is this correct? -->"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("question");
  });

  it("detects -- AI: comments", () => {
    const doc = makeDocWithLines(["-- AI: TASK: optimize query"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("task");
    expect(results[0].syntax).toBe("--");
  });

  it("defaults severity to task when no keyword", () => {
    const doc = makeDocWithLines(["// AI: some general note"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results[0].severity).toBe("task");
    expect(results[0].comment).toBe("some general note");
  });

  it("is case insensitive for severity keywords", () => {
    const doc = makeDocWithLines(["// AI: fix: lower case"]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results[0].severity).toBe("fix");
  });

  it("returns empty for no matches", () => {
    const doc = makeDocWithLines(["const x = 1;", "// normal comment"]);
    expect(scanDocumentForAIComments(doc as any)).toEqual([]);
  });

  it("captures fullLine trimmed", () => {
    const doc = makeDocWithLines(["  // AI: TODO: thing  "]);
    const results = scanDocumentForAIComments(doc as any);
    expect(results[0].fullLine).toBe("// AI: TODO: thing");
  });
});

describe("scanAllOpenDocuments", () => {
  it("scans all open file-scheme documents", () => {
    const doc1 = makeDocWithLines(["// AI: FIX: bug1"], "/workspace/a.ts");
    const doc2 = makeDocWithLines(["# AI: TODO: task1"], "/workspace/b.py");
    vscode.workspace.textDocuments = [doc1, doc2] as any;

    const results = scanAllOpenDocuments();
    expect(results).toHaveLength(2);
  });

  it("uses cache on second call", () => {
    const lineAt = vi.fn((n: number) => ({ text: n === 0 ? "// AI: note" : "" }));
    const doc = _mockTextDocument({ fsPath: "/workspace/file.ts", lineCount: 1, lineAt });
    vscode.workspace.textDocuments = [doc] as any;

    scanAllOpenDocuments();
    scanAllOpenDocuments();
    // lineAt should only be called during the first scan (cache hit on second)
    const firstCallCount = lineAt.mock.calls.length;
    scanAllOpenDocuments();
    expect(lineAt.mock.calls.length).toBe(firstCallCount); // no additional calls
  });

  it("rescans after invalidateDocumentCache", () => {
    const doc = makeDocWithLines(["// AI: note"], "/workspace/file.ts");
    vscode.workspace.textDocuments = [doc] as any;

    const r1 = scanAllOpenDocuments();
    invalidateDocumentCache(doc.uri.toString());
    const r2 = scanAllOpenDocuments();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });
});

describe("handleGetAIComments", () => {
  it("returns all scanned comments", async () => {
    const doc = makeDocWithLines(["// AI: FIX: urgent"], "/workspace/file.ts");
    vscode.workspace.textDocuments = [doc] as any;

    const result = (await handleGetAIComments()) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("fix");
  });
});
