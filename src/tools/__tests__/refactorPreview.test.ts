import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createRefactorPreviewTool } from "../refactorPreview.js";

function mockClient(
  connected: boolean,
  previewResult: unknown = null,
  throwTimeout = false,
) {
  return {
    isConnected: () => connected,
    previewCodeAction: vi.fn(async () => {
      if (throwTimeout) throw new ExtensionTimeoutError("timeout");
      return previewResult;
    }),
  } as any;
}

describe("refactorPreview", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "refactor-preview-test-"),
    );
    // Create a dummy file so resolveFilePath succeeds
    fs.writeFileSync(path.join(workspace, "foo.ts"), "");
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns extension_required when disconnected", async () => {
    const tool = createRefactorPreviewTool(workspace, mockClient(false));
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Extract function",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("extension_required");
  });

  it("returns preview data on success", async () => {
    const preview = {
      title: "Extract function",
      changes: [
        {
          file: path.join(workspace, "foo.ts"),
          edits: [
            {
              range: {
                startLine: 1,
                startColumn: 1,
                endLine: 5,
                endColumn: 1,
              },
              newText: "function extracted() {}",
            },
          ],
        },
      ],
      totalFiles: 1,
      totalEdits: 1,
    };
    const tool = createRefactorPreviewTool(
      workspace,
      mockClient(true, preview),
    );
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Extract function",
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.title).toBe("Extract function");
    expect(data.totalFiles).toBe(1);
  });

  it("returns error when extension returns null", async () => {
    const tool = createRefactorPreviewTool(workspace, mockClient(true, null));
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Extract function",
    });
    expect(result.isError).toBe(true);
  });

  it("returns timeout error on ExtensionTimeoutError", async () => {
    const tool = createRefactorPreviewTool(
      workspace,
      mockClient(true, null, true),
    );
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Extract function",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});
