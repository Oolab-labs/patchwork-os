import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createCheckDocumentDirtyTool } from "../checkDocumentDirty.js";
import { createCloseTabTool } from "../closeTabs.js";
import { createGetDiagnosticsTool } from "../getDiagnostics.js";
import { createOpenDiffTool } from "../openDiff.js";
import { createOpenFileTool } from "../openFile.js";
import { createSaveDocumentTool } from "../saveDocument.js";

function parseResult(result: {
  content: Array<{ type: string; text: string }>;
}) {
  const text = result.content.at(0)?.text ?? "{}";
  return JSON.parse(text);
}

// Create a real temp workspace for testing
let workspace: string;
let testFile: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  testFile = path.join(workspace, "test.ts");
  fs.writeFileSync(testFile, "const x = 1;\nconst y = 2;\n");
});

describe("openFile validation", () => {
  it("rejects missing filePath", async () => {
    const tool = createOpenFileTool(workspace, null, new Set());
    await expect(tool.handler({})).rejects.toThrow("filePath must be a string");
  });

  it("rejects non-string filePath", async () => {
    const tool = createOpenFileTool(workspace, null, new Set());
    await expect(tool.handler({ filePath: 123 })).rejects.toThrow(
      "filePath must be a string",
    );
  });

  it("rejects non-integer startLine", async () => {
    const tool = createOpenFileTool(workspace, null, new Set());
    await expect(
      tool.handler({ filePath: "test.ts", startLine: "not-a-number" }),
    ).rejects.toThrow("startLine must be an integer");
  });

  it("rejects oversized startText", async () => {
    const tool = createOpenFileTool(workspace, null, new Set());
    await expect(
      tool.handler({ filePath: "test.ts", startText: "a".repeat(600) }),
    ).rejects.toThrow("startText exceeds maximum length");
  });

  it("accepts valid arguments", async () => {
    const openedFiles = new Set<string>();
    const tool = createOpenFileTool(workspace, null, openedFiles);
    const result = await tool.handler({
      filePath: "test.ts",
      startLine: 1,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(openedFiles.has(testFile)).toBe(true);
  });
});

describe("openDiff validation", () => {
  it("rejects missing required fields", async () => {
    const tool = createOpenDiffTool(workspace, null);
    await expect(tool.handler({})).rejects.toThrow("must be a string");
  });

  it("rejects empty newFilePath basename", async () => {
    const tool = createOpenDiffTool(workspace, null);
    const result = await tool.handler({
      oldFilePath: "test.ts",
      newFilePath: "..",
      newFileContents: "content",
      tabName: "diff",
    });
    const text = result.content.at(0)?.text ?? "";
    expect(text).toContain("invalid basename");
  });

  it("rejects dot basename", async () => {
    const tool = createOpenDiffTool(workspace, null);
    const result = await tool.handler({
      oldFilePath: "test.ts",
      newFilePath: ".",
      newFileContents: "content",
      tabName: "diff",
    });
    const text = result.content.at(0)?.text ?? "";
    expect(text).toContain("invalid basename");
  });

  it("accepts valid arguments", async () => {
    const tool = createOpenDiffTool(workspace, null);
    const result = await tool.handler({
      oldFilePath: "test.ts",
      newFilePath: "test-new.ts",
      newFileContents: "const x = 2;\n",
      tabName: "test diff",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
  });
});

describe("getDiagnostics validation", () => {
  it("rejects non-string uri", async () => {
    const tool = createGetDiagnosticsTool(workspace);
    await expect(tool.handler({ uri: 123 })).rejects.toThrow(
      "uri must be a string",
    );
  });

  it("accepts missing uri (returns all diagnostics)", async () => {
    const tool = createGetDiagnosticsTool(workspace);
    const result = await tool.handler({});
    const data = parseResult(result);
    expect(data).toBeDefined();
  });
});

describe("checkDocumentDirty validation", () => {
  it("rejects missing filePath", async () => {
    const tool = createCheckDocumentDirtyTool(workspace);
    await expect(tool.handler({})).rejects.toThrow("filePath must be a string");
  });

  it("rejects non-string filePath", async () => {
    const tool = createCheckDocumentDirtyTool(workspace);
    await expect(tool.handler({ filePath: null })).rejects.toThrow(
      "filePath must be a string",
    );
  });
});

describe("saveDocument validation", () => {
  it("rejects missing filePath", async () => {
    const tool = createSaveDocumentTool(workspace);
    await expect(tool.handler({})).rejects.toThrow("filePath must be a string");
  });
});

describe("closeTab validation", () => {
  it("rejects missing filePath", async () => {
    const tool = createCloseTabTool();
    await expect(tool.handler({})).rejects.toThrow("filePath must be a string");
  });

  it("rejects non-string filePath", async () => {
    const tool = createCloseTabTool();
    await expect(tool.handler({ filePath: 42 })).rejects.toThrow(
      "filePath must be a string",
    );
  });
});
