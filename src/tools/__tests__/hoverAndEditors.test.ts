import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetOpenEditorsTool } from "../getOpenEditors.js";
import { createGetHoverAtCursorTool } from "../hoverAtCursor.js";

// Mock node:fs so stat doesn't hit the real filesystem
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        stat: vi.fn(async () => ({ size: 400 })),
      },
    },
  };
});

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

// ── hoverAtCursor ─────────────────────────────────────────────────────────────

function makeHoverClient(opts: {
  connected: boolean;
  activeFile?: string | null;
  selection?: { startLine: number; startColumn: number } | null;
  hoverResult?: object | null;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    latestActiveFile: opts.activeFile ?? null,
    latestSelection: opts.selection ?? null,
    getHover: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.hoverResult ?? null;
    }),
  } as any;
}

describe("createGetHoverAtCursorTool", () => {
  it("returns extensionRequired when extension disconnected", async () => {
    const tool = createGetHoverAtCursorTool(
      makeHoverClient({ connected: false }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });

  it("returns error when no active file is tracked", async () => {
    const tool = createGetHoverAtCursorTool(
      makeHoverClient({ connected: true, activeFile: null }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No active file");
  });

  it("returns hover result when found", async () => {
    const tool = createGetHoverAtCursorTool(
      makeHoverClient({
        connected: true,
        activeFile: "/ws/src/index.ts",
        selection: { startLine: 10, startColumn: 5 },
        hoverResult: { markdown: "function foo(): void" },
      }),
    );
    const data = parse(await tool.handler());
    expect(data.found).toBe(true);
    expect(data.file).toBe("/ws/src/index.ts");
    expect(data.line).toBe(10);
    expect(data.column).toBe(5);
    expect(data.hover).toMatchObject({ markdown: "function foo(): void" });
  });

  it("returns found:false when hover result is null", async () => {
    const tool = createGetHoverAtCursorTool(
      makeHoverClient({
        connected: true,
        activeFile: "/ws/a.ts",
        selection: null,
        hoverResult: null,
      }),
    );
    const data = parse(await tool.handler());
    expect(data.found).toBe(false);
    expect(data.message).toContain("No hover information");
  });

  it("defaults to line 1 col 1 when no selection tracked", async () => {
    const client = makeHoverClient({
      connected: true,
      activeFile: "/ws/a.ts",
      selection: null,
      hoverResult: { markdown: "x" },
    });
    const tool = createGetHoverAtCursorTool(client);
    await tool.handler();
    expect(client.getHover).toHaveBeenCalledWith("/ws/a.ts", 1, 1);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createGetHoverAtCursorTool(
      makeHoverClient({
        connected: true,
        activeFile: "/ws/a.ts",
        throwTimeout: true,
      }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("re-throws non-timeout errors", async () => {
    const client = {
      isConnected: vi.fn(() => true),
      latestActiveFile: "/ws/a.ts",
      latestSelection: null,
      getHover: vi.fn(async () => {
        throw new Error("unexpected");
      }),
    } as any;
    const tool = createGetHoverAtCursorTool(client);
    await expect(tool.handler()).rejects.toThrow("unexpected");
  });
});

// ── getOpenEditors ────────────────────────────────────────────────────────────

function makeEditorClient(opts: {
  connected: boolean;
  openFiles?: object[] | null;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    getOpenFiles: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("timeout");
      return opts.openFiles ?? null;
    }),
  } as any;
}

describe("createGetOpenEditorsTool", () => {
  it("returns local-tracking when extension not provided", async () => {
    const openedFiles = new Set(["/ws/src/a.ts"]);
    const tool = createGetOpenEditorsTool(openedFiles);
    const data = parse(await tool.handler());
    expect(data.source).toBe("local-tracking");
    expect(data.tabs).toHaveLength(1);
    expect(data.tabs[0].fileName).toBe("/ws/src/a.ts");
  });

  it("returns local-tracking when extension disconnected", async () => {
    const openedFiles = new Set(["/ws/b.ts"]);
    const tool = createGetOpenEditorsTool(
      openedFiles,
      makeEditorClient({ connected: false }),
    );
    const data = parse(await tool.handler());
    expect(data.source).toBe("local-tracking");
  });

  it("returns vscode tabs when extension connected and returns array", async () => {
    const tabs = [
      {
        filePath: "/ws/main.ts",
        isActive: true,
        isDirty: false,
        languageId: "typescript",
      },
    ];
    const tool = createGetOpenEditorsTool(
      new Set(),
      makeEditorClient({ connected: true, openFiles: tabs }),
    );
    const data = parse(await tool.handler());
    expect(data.source).toBe("vscode");
    expect(data.tabs).toHaveLength(1);
    expect(data.tabs[0].fileName).toBe("/ws/main.ts");
    expect(data.tabs[0].languageId).toBe("typescript");
  });

  it("uses languageIdFromPath when languageId is missing from tab", async () => {
    const tabs = [{ filePath: "/ws/app.py", isActive: false, isDirty: false }];
    const tool = createGetOpenEditorsTool(
      new Set(),
      makeEditorClient({ connected: true, openFiles: tabs }),
    );
    const data = parse(await tool.handler());
    expect(data.tabs[0].languageId).toBe("python");
  });

  it("falls back to local-tracking on ExtensionTimeoutError", async () => {
    const openedFiles = new Set(["/ws/fallback.ts"]);
    const tool = createGetOpenEditorsTool(
      openedFiles,
      makeEditorClient({ connected: true, throwTimeout: true }),
    );
    const data = parse(await tool.handler());
    expect(data.source).toBe("local-tracking");
  });

  it("falls back to local-tracking when extension returns null", async () => {
    const openedFiles = new Set(["/ws/c.ts"]);
    const tool = createGetOpenEditorsTool(
      openedFiles,
      makeEditorClient({ connected: true, openFiles: null }),
    );
    const data = parse(await tool.handler());
    expect(data.source).toBe("local-tracking");
  });

  it("removes inaccessible files from openedFiles set during fallback", async () => {
    // import fs mock to simulate stat failure
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.promises.stat).mockRejectedValueOnce(new Error("ENOENT"));
    const openedFiles = new Set(["/ws/gone.ts"]);
    const tool = createGetOpenEditorsTool(openedFiles);
    await tool.handler();
    expect(openedFiles.has("/ws/gone.ts")).toBe(false);
  });
});
