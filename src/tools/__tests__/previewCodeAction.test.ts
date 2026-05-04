import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createPreviewCodeActionTool } from "../lsp.js";

function mockClient(
  connected: boolean,
  previewResult: unknown = null,
  throwTimeout = false,
) {
  return {
    isConnected: () => connected,
    lspReadyLanguages: new Set(["typescript"]),
    previewCodeAction: vi.fn(async () => {
      if (throwTimeout) throw new ExtensionTimeoutError("timeout");
      return previewResult;
    }),
  } as any;
}

describe("previewCodeAction", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "preview-code-action-test-"),
    );
    fs.writeFileSync(path.join(workspace, "foo.ts"), "");
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns extension_required when disconnected", async () => {
    const tool = createPreviewCodeActionTool(workspace, mockClient(false));
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Add missing import",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe("extension_required");
  });

  it("returns preview data on success", async () => {
    const preview = {
      title: "Add missing import",
      changes: [
        {
          file: path.join(workspace, "foo.ts"),
          edits: [
            {
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
              newText: 'import { foo } from "./bar";\n',
            },
          ],
        },
      ],
      totalFiles: 1,
      totalEdits: 1,
    };
    const tool = createPreviewCodeActionTool(
      workspace,
      mockClient(true, preview),
    );
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Add missing import",
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.title).toBe("Add missing import");
    expect(data.totalFiles).toBe(1);
    expect(data.totalEdits).toBe(1);
    expect(data.changes[0].edits[0].newText).toContain("import");
  });

  it("emits structuredContent consistent with text", async () => {
    const preview = {
      title: "Fix spelling",
      changes: [],
      totalFiles: 0,
      totalEdits: 0,
    };
    const tool = createPreviewCodeActionTool(
      workspace,
      mockClient(true, preview),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 5,
      actionTitle: "Fix spelling",
    })) as any;
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(
      JSON.parse(result.content[0].text),
    );
  });

  it("returns error when extension returns null", async () => {
    const tool = createPreviewCodeActionTool(workspace, mockClient(true, null));
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Fix",
    });
    expect(result.isError).toBe(true);
  });

  it("returns timeout error on ExtensionTimeoutError", async () => {
    const tool = createPreviewCodeActionTool(
      workspace,
      mockClient(true, null, true),
    );
    const result = await tool.handler({
      filePath: "foo.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      actionTitle: "Fix",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});
