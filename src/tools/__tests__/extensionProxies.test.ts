/**
 * Tests for extension-proxy tools against a disconnected extension client.
 *
 * The most important failure path is when the extension is not connected:
 * tools must return a graceful MCP error (isError: true) rather than throwing
 * or returning a JSON-RPC error.
 *
 * Mock pattern follows nativeFallbacks.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../config.js";
import {
  createReadClipboardTool,
  createWriteClipboardTool,
} from "../clipboard.js";
import { createGetBufferContentTool } from "../getBufferContent.js";
import { createReplaceBlockTool } from "../replaceBlock.js";
import {
  createExecuteVSCodeCommandTool,
  createListVSCodeCommandsTool,
} from "../vscodeCommands.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockDisconnectedExtensionClient(): any {
  return {
    isConnected: () => false,
    getFileContent: () => null,
    replaceBlock: () => null,
    readClipboard: () => null,
    writeClipboard: () => null,
    executeVSCodeCommand: () => null,
    listVSCodeCommands: () => null,
  };
}

function makeMinimalConfig(overrides: Partial<Config> = {}): Config {
  return {
    workspace: "/tmp",
    workspaceFolders: ["/tmp"],
    ideName: "Test",
    editorCommand: null,
    port: null,
    bindAddress: "127.0.0.1",
    verbose: false,
    jsonl: false,
    linters: [],
    commandAllowlist: [],
    commandTimeout: 30_000,
    maxResultSize: 512 * 1024,
    vscodeCommandAllowlist: [],
    activeWorkspaceFolder: "/tmp",
    gracePeriodMs: 30_000,
    ...overrides,
  };
}

// ── getBufferContent ──────────────────────────────────────────────────────────

describe("getBufferContent: disconnected extension", () => {
  let workspace: string;
  let testFile: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-buf-"));
    testFile = path.join(workspace, "sample.ts");
    fs.writeFileSync(testFile, "const x = 1;\n");
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("falls back to disk content when extension is not connected", async () => {
    const tool = createGetBufferContentTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({ filePath: "sample.ts" })) as any;
    // Should succeed (disk fallback), not return an error
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBeDefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toContain("const x = 1");
    expect(parsed.source).toBe("disk");
  });

  it("returns isError when file does not exist", async () => {
    const tool = createGetBufferContentTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({ filePath: "nonexistent.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("serves a line range from a large file (>512KB) without error", async () => {
    // Write a file larger than MAX_CONTENT_BYTES (512 KB)
    const bigFile = path.join(workspace, "big.ts");
    const lineCount = 15_000;
    const lines = Array.from(
      { length: lineCount },
      (_, i) => `const line${i} = ${i}; // padding padding padding padding`,
    );
    fs.writeFileSync(bigFile, lines.join("\n"));

    const tool = createGetBufferContentTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({
      filePath: "big.ts",
      startLine: 100,
      endLine: 150,
    })) as any;

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toContain("const line99");
    expect(parsed.startLine).toBe(100);
    expect(parsed.endLine).toBe(150);
    expect(parsed.totalLines).toBe(lineCount);
  });

  it("returns isError for large file when no range is specified", async () => {
    const bigFile = path.join(workspace, "big.ts");
    // big.ts already created by previous test (or create if running in isolation)
    if (!fs.existsSync(bigFile)) {
      const lines = Array.from(
        { length: 15_000 },
        (_, i) => `const line${i} = ${i}; // padding padding padding padding`,
      );
      fs.writeFileSync(bigFile, lines.join("\n"));
    }

    const tool = createGetBufferContentTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({ filePath: "big.ts" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too large");
  });
});

// ── replaceBlock ──────────────────────────────────────────────────────────────

describe("replaceBlock: disconnected extension", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-replace-"));
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("applies native fs fallback when extension is not connected", async () => {
    const testFile = path.join(workspace, "edit.ts");
    fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\n");

    const tool = createReplaceBlockTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({
      filePath: "edit.ts",
      oldContent: "const a = 1;",
      newContent: "const a = 42;",
    })) as any;

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.source).toBe("native-fs");
    expect(fs.readFileSync(testFile, "utf-8")).toContain("const a = 42;");
  });

  it("returns isError when oldContent is not found in file", async () => {
    const testFile = path.join(workspace, "notfound.ts");
    fs.writeFileSync(testFile, "const z = 99;\n");

    const tool = createReplaceBlockTool(
      workspace,
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({
      filePath: "notfound.ts",
      oldContent: "const x = 1;",
      newContent: "const x = 2;",
    })) as any;

    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg).toContain("not found");
  });
});

// ── clipboard ─────────────────────────────────────────────────────────────────

describe("readClipboard: disconnected extension", () => {
  it("attempts native fallback and returns result or informative error", async () => {
    const tool = createReadClipboardTool(mockDisconnectedExtensionClient());
    const result = (await tool.handler()) as any;
    // With native fallback the tool may succeed (on macOS via pbpaste) or fail
    // with an informative error — but must never return the old "extension required" stub.
    if (result.isError) {
      const msg = result.content[0].text;
      expect(msg.toLowerCase()).not.toContain("vs code extension is required");
      expect(msg.toLowerCase()).toContain("clipboard");
    } else {
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        text: expect.any(String),
      });
    }
  });
});

describe("writeClipboard: disconnected extension", () => {
  it("attempts native fallback and returns success or informative error", async () => {
    const tool = createWriteClipboardTool(mockDisconnectedExtensionClient());
    const result = (await tool.handler({ text: "hello" })) as any;
    if (result.isError) {
      const msg = result.content[0].text;
      expect(msg.toLowerCase()).not.toContain("vs code extension is required");
      expect(msg.toLowerCase()).toContain("clipboard");
    } else {
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: true,
      });
    }
  });
});

// ── vscodeCommands ────────────────────────────────────────────────────────────

function mockConnectedExtensionClient(executeResult: unknown = null): any {
  return {
    isConnected: () => true,
    executeVSCodeCommand: async () => executeResult,
    listVSCodeCommands: async () => null,
  };
}

describe("executeVSCodeCommand: allowlist enforcement", () => {
  it("rejects a command not in the allowlist (extension connected)", async () => {
    const config = makeMinimalConfig({
      vscodeCommandAllowlist: ["workbench.action.openSettings"],
    });
    const tool = createExecuteVSCodeCommandTool(
      mockConnectedExtensionClient(),
      config,
    );
    const result = (await tool.handler({
      command: "editor.action.formatDocument",
    })) as any;
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg).toContain("not in the vscodeCommandAllowlist");
  });

  it("rejects all commands when no allowlist is configured (extension connected)", async () => {
    const config = makeMinimalConfig({ vscodeCommandAllowlist: [] });
    const tool = createExecuteVSCodeCommandTool(
      mockConnectedExtensionClient(),
      config,
    );
    const result = (await tool.handler({
      command: "editor.action.formatDocument",
    })) as any;
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg).toContain("allowlist");
  });

  it("returns isError:true when extension not connected", async () => {
    const config = makeMinimalConfig({
      vscodeCommandAllowlist: ["editor.action.formatDocument"],
    });
    const tool = createExecuteVSCodeCommandTool(
      mockDisconnectedExtensionClient(),
      config,
    );
    const result = (await tool.handler({
      command: "editor.action.formatDocument",
    })) as any;
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg.toLowerCase()).toContain("extension");
  });
});

describe("listVSCodeCommands: disconnected extension", () => {
  it("returns isError:true when extension not connected", async () => {
    const tool = createListVSCodeCommandsTool(
      mockDisconnectedExtensionClient(),
    );
    const result = (await tool.handler({})) as any;
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg.toLowerCase()).toContain("extension");
  });
});
