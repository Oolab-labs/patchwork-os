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

  // getFileContent's real extension shape is an object with content + metadata
  const fileContentResponse =
    typeof fileContent === "string"
      ? {
          content: fileContent,
          isDirty: false,
          languageId: "typescript",
          source: "vscode-buffer",
        }
      : fileContent;

  return {
    isConnected: () => isConnected,
    latestActiveFile,
    getDiagnostics: vi.fn(async () => diagnostics),
    getOpenFiles: vi.fn(async () => openFiles),
    getFileContent: vi.fn(async () => fileContentResponse),
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

  // Regression: tools-rest-1 — the cap must be byte-accurate. A CJK string with
  // .length === 16000 (under the old UTF-16 gate) is ~48 KB in UTF-8 and must
  // be truncated to ~16 KB of bytes, not passed through whole.
  it("truncates activeFileContent by BYTES, not UTF-16 length, for CJK", async () => {
    // Each CJK char is 3 UTF-8 bytes. 16000 chars = 48000 bytes, well over 16 KB,
    // but .length (16000) is under the old 16384 char gate that this fix replaces.
    const cjk = "中".repeat(16000);
    expect(cjk.length).toBeLessThan(16384);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(16384);

    const client = makeExtensionClient({ fileContent: cjk });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.activeFileContent).toContain("truncated at 16KB");
    // The kept slice must be at or under 16 KB of UTF-8 bytes (the marker text
    // is appended after, so check the content portion before the marker).
    const kept = (content.activeFileContent as string).split(
      "\n[file truncated",
    )[0] as string;
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(16384);
  });

  it("gracefully handles getDiagnostics failure", async () => {
    const client = makeExtensionClient();
    client.getDiagnostics = vi.fn(async () => {
      throw new Error("LSP crash");
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    // diagnostics omitted on failure, but bundle still returned
    expect(content.bundledAt).toBeTypeOf("number");
    expect(content.diagnostics).toBeUndefined();
  });

  it("caps diagnostics at 50 and sets diagnosticsTruncated", async () => {
    const manyDiags = Array.from({ length: 80 }, (_, i) => ({
      severity: "error",
      message: `Error ${i}`,
      file: "/workspace/src/app.ts",
    }));
    const client = makeExtensionClient({ diagnostics: manyDiags });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.diagnostics).toHaveLength(50);
    expect(content.diagnosticsTruncated).toBe(true);
    expect(content.diagnosticsTotalCount).toBe(80);
  });

  it("does not set diagnosticsTruncated when diagnostics are within cap", async () => {
    const client = makeExtensionClient({
      diagnostics: [
        {
          severity: "error",
          message: "One error",
          file: "/workspace/src/app.ts",
        },
      ],
    });
    const tool = createContextBundleTool("/workspace", client as never);
    const result = await tool.handler({});
    const content = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(content.diagnostics).toHaveLength(1);
    expect(content.diagnosticsTruncated).toBeUndefined();
  });

  describe("summarize: true", () => {
    it("includes diagnosticSummary field", async () => {
      const client = makeExtensionClient({
        diagnostics: [
          {
            severity: "error",
            message: "Type error",
            file: "/workspace/src/auth.ts",
          },
          {
            severity: "warning",
            message: "Unused var",
            file: "/workspace/src/utils.ts",
          },
        ],
      });
      const tool = createContextBundleTool("/workspace", client as never);
      const result = await tool.handler({ summarize: true });
      const content = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      expect(typeof content.diagnosticSummary).toBe("string");
      expect(content.diagnosticSummary).toContain("auth.ts");
    });

    it("caps diagnostics to 5", async () => {
      const manyDiags = Array.from({ length: 10 }, (_, i) => ({
        severity: i % 2 === 0 ? "error" : "warning",
        message: `Diag ${i}`,
        file: `/workspace/src/file${i}.ts`,
      }));
      const client = makeExtensionClient({ diagnostics: manyDiags });
      const tool = createContextBundleTool("/workspace", client as never);
      const result = await tool.handler({ summarize: true });
      const content = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      expect(content.diagnostics.length).toBeLessThanOrEqual(5);
    });

    it("caps activeFileContent to 20 lines when there are errors", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      const longContent = lines.join("\n");
      const client = makeExtensionClient({
        fileContent: longContent,
        diagnostics: [
          {
            severity: "error",
            message: "Type error",
            file: "/workspace/src/app.ts",
            line: 50,
          },
        ],
      });
      const tool = createContextBundleTool("/workspace", client as never);
      const result = await tool.handler({ summarize: true });
      const content = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      const resultLines = (content.activeFileContent as string).split("\n");
      expect(resultLines.length).toBeLessThanOrEqual(20);
    });

    it("defaults to false — no behavior change without param", async () => {
      const client = makeExtensionClient({
        diagnostics: Array.from({ length: 10 }, (_, i) => ({
          severity: "error",
          message: `Err ${i}`,
          file: "/workspace/src/app.ts",
        })),
      });
      const tool = createContextBundleTool("/workspace", client as never);
      const result = await tool.handler({});
      const content = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      expect(content.diagnosticSummary).toBeUndefined();
      expect(content.diagnostics.length).toBe(10);
    });
  });
});
