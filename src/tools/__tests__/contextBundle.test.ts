import { describe, expect, it, vi } from "vitest";
import { createContextBundleTool } from "../contextBundle.js";

function makeExtensionClient(
  overrides: Partial<{
    isConnected: boolean;
    latestActiveFile: string | null;
    diagnostics: unknown[] | null;
    openFiles: unknown[] | null;
    fileContent: unknown;
  }> = {},
) {
  const {
    isConnected = true,
    latestActiveFile = "/workspace/src/app.ts",
    diagnostics = [
      {
        severity: "error",
        message: "Type error",
        file: "/workspace/src/app.ts",
      },
    ],
    openFiles = [{ file: "/workspace/src/app.ts" }],
    fileContent = "const x: string = 42;",
  } = overrides;

  return {
    isConnected: () => isConnected,
    latestActiveFile,
    getDiagnostics: vi.fn(async () => diagnostics),
    getOpenFiles: vi.fn(async () => openFiles),
    getFileContent: vi.fn(async () => fileContent),
  };
}

describe("createContextBundleTool", () => {
  it("always returns bundledAt", async () => {
    const client = makeExtensionClient({
      isConnected: false,
      latestActiveFile: null,
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const before = Date.now();
    const result = await tool.handler({});
    const after = Date.now();
    expect(result.isError).toBeFalsy();
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.bundledAt).toBeGreaterThanOrEqual(before);
    expect(content.bundledAt).toBeLessThanOrEqual(after);
  });

  it("returns all fields when extension is connected", async () => {
    const client = makeExtensionClient();
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.activeFile).toBe("/workspace/src/app.ts");
    expect(content.activeFileContent).toBe("const x: string = 42;");
    expect(Array.isArray(content.diagnostics)).toBe(true);
    expect(Array.isArray(content.openEditors)).toBe(true);
    expect(content.bundledAt).toBeTypeOf("number");
  });

  it("omits extension fields when disconnected", async () => {
    const client = makeExtensionClient({
      isConnected: false,
      latestActiveFile: null,
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.activeFile).toBeUndefined();
    expect(content.activeFileContent).toBeUndefined();
    expect(content.diagnostics).toBeUndefined();
    expect(content.openEditors).toBeUndefined();
    expect(content.bundledAt).toBeTypeOf("number");
  });

  it("skips diff when includeDiff: false", async () => {
    const client = makeExtensionClient({
      isConnected: false,
      latestActiveFile: null,
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({ includeDiff: false });
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.diff).toBeUndefined();
  });

  it("skips handoff note when includeHandoffNote: false", async () => {
    const client = makeExtensionClient({
      isConnected: false,
      latestActiveFile: null,
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({ includeHandoffNote: false });
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.handoffNote).toBeUndefined();
  });

  it("truncates activeFileContent at 16KB", async () => {
    const longContent = "x".repeat(40000);
    const client = makeExtensionClient({ fileContent: longContent });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.activeFileContent?.length).toBeLessThan(40000);
    expect(content.activeFileContent).toContain("truncated at 16KB");
  });

  it("gracefully handles getDiagnostics failure", async () => {
    const client = makeExtensionClient();
    client.getDiagnostics = vi.fn(async () => {
      throw new Error("LSP crash");
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    // diagnostics omitted on failure, but bundle still returned
    expect(content.bundledAt).toBeTypeOf("number");
    expect(content.diagnostics).toBeUndefined();
  });
});
