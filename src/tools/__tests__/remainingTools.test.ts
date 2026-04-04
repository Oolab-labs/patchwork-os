/**
 * Tests for the remaining uncovered tool files:
 *   activityLog.ts, decorations.ts, getCurrentSelection.ts,
 *   inlayHints.ts, setActiveWorkspaceFolder.ts, typeHierarchy.ts,
 *   workspaceSettings.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGetActivityLogTool } from "../activityLog.js";
import {
  createClearEditorDecorationsTool,
  createSetEditorDecorationsTool,
} from "../decorations.js";
import {
  createGetCurrentSelectionTool,
  createGetLatestSelectionTool,
} from "../getCurrentSelection.js";
import { createGetInlayHintsTool } from "../inlayHints.js";
import { createSetActiveWorkspaceFolderTool } from "../setActiveWorkspaceFolder.js";
import { createGetTypeHierarchyTool } from "../typeHierarchy.js";
import {
  createGetWorkspaceSettingsTool,
  createSetWorkspaceSettingTool,
} from "../workspaceSettings.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const disconnected = { isConnected: () => false } as any;

// ── activityLog ───────────────────────────────────────────────────────────────

function makeActivityLog(entries: unknown[] = []) {
  return {
    query: vi.fn().mockReturnValue(entries),
    stats: vi.fn().mockReturnValue({ totalCalls: entries.length }),
  } as any;
}

describe("getActivityLog", () => {
  it("returns entries and count", async () => {
    const log = makeActivityLog([{ tool: "openFile" }, { tool: "editText" }]);
    const tool = createGetActivityLogTool(log);
    const result = parse(await tool.handler({}));
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("passes tool and status filters to query()", async () => {
    const log = makeActivityLog([]);
    const tool = createGetActivityLogTool(log);
    await tool.handler({ tool: "openFile", status: "error", last: 10 });
    expect(log.query).toHaveBeenCalledWith({
      tool: "openFile",
      status: "error",
      last: 10,
    });
  });

  it("includes stats when showStats is true", async () => {
    const log = makeActivityLog([]);
    const tool = createGetActivityLogTool(log);
    const result = parse(await tool.handler({ showStats: true }));
    expect(log.stats).toHaveBeenCalledOnce();
    expect(result.stats).toBeDefined();
  });

  it("omits stats by default", async () => {
    const log = makeActivityLog([]);
    const tool = createGetActivityLogTool(log);
    const result = parse(await tool.handler({}));
    expect(log.stats).not.toHaveBeenCalled();
    expect(result.stats).toBeUndefined();
  });

  it("defaults last to 50", async () => {
    const log = makeActivityLog([]);
    const tool = createGetActivityLogTool(log);
    await tool.handler({});
    expect(log.query).toHaveBeenCalledWith(
      expect.objectContaining({ last: 50 }),
    );
  });
});

// ── setEditorDecorations ──────────────────────────────────────────────────────

describe("setEditorDecorations — extension required", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "decorations-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const x = 1;\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns extensionRequired when disconnected", async () => {
    const tool = createSetEditorDecorationsTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        id: "highlights",
        file: "test.ts",
        decorations: [],
      }),
    );
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("throws on invalid decoration item (not an object)", async () => {
    const ext = {
      isConnected: () => true,
      setDecorations: vi.fn(),
    } as any;
    const tool = createSetEditorDecorationsTool(tmpDir, ext);
    await expect(
      tool.handler({
        id: "h",
        file: "test.ts",
        decorations: ["not-an-object"],
      }),
    ).rejects.toThrow(/must be an object/i);
  });

  it("throws on invalid style value", async () => {
    const ext = {
      isConnected: () => true,
      setDecorations: vi.fn(),
    } as any;
    const tool = createSetEditorDecorationsTool(tmpDir, ext);
    await expect(
      tool.handler({
        id: "h",
        file: "test.ts",
        decorations: [{ startLine: 1, style: "neon" }],
      }),
    ).rejects.toThrow(/style is invalid/i);
  });

  it("calls setDecorations with valid args when connected", async () => {
    const ext = {
      isConnected: () => true,
      setDecorations: vi.fn().mockResolvedValue({ set: true }),
    } as any;
    const tool = createSetEditorDecorationsTool(tmpDir, ext);
    const result = parse(
      await tool.handler({
        id: "h",
        file: "test.ts",
        decorations: [{ startLine: 1, style: "info", message: "ok" }],
      }),
    );
    expect(ext.setDecorations).toHaveBeenCalledOnce();
    expect(result.set).toBe(true);
  });
});

describe("clearEditorDecorations — extension required", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createClearEditorDecorationsTool(disconnected);
    const result = parse(await tool.handler({}));
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("calls clearDecorations with id when provided", async () => {
    const ext = {
      isConnected: () => true,
      clearDecorations: vi.fn().mockResolvedValue({ cleared: true }),
    } as any;
    const tool = createClearEditorDecorationsTool(ext);
    const result = parse(await tool.handler({ id: "highlights" }));
    expect(ext.clearDecorations).toHaveBeenCalledWith("highlights");
    expect(result.cleared).toBe(true);
  });

  it("calls clearDecorations with undefined id when omitted (clear all)", async () => {
    const ext = {
      isConnected: () => true,
      clearDecorations: vi.fn().mockResolvedValue({ cleared: true }),
    } as any;
    const tool = createClearEditorDecorationsTool(ext);
    await tool.handler({});
    expect(ext.clearDecorations).toHaveBeenCalledWith(undefined);
  });
});

// ── getCurrentSelection ───────────────────────────────────────────────────────

describe("getCurrentSelection", () => {
  it("returns extension selection when connected and not null", async () => {
    const ext = {
      isConnected: () => true, // note: not used in handler — it calls getSelection directly
      getSelection: vi.fn().mockResolvedValue({ text: "hello", line: 1 }),
    } as any;
    const tool = createGetCurrentSelectionTool(ext);
    const result = parse(await tool.handler());
    expect(result.success).toBe(true);
    expect(result.source).toBe("extension");
    expect(result.selection.text).toBe("hello");
  });

  it("returns stub when extension returns null", async () => {
    const ext = {
      getSelection: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createGetCurrentSelectionTool(ext);
    const result = parse(await tool.handler());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available/i);
  });
});

describe("getLatestSelection", () => {
  it("returns cached latestSelection when available", async () => {
    const ext = {
      latestSelection: { text: "cached", line: 5 },
      getSelection: vi.fn(),
    } as any;
    const tool = createGetLatestSelectionTool(ext);
    const result = parse(await tool.handler());
    expect(result.source).toBe("extension-cached");
    expect(result.selection.text).toBe("cached");
    expect(ext.getSelection).not.toHaveBeenCalled();
  });

  it("falls back to live request when no cached selection", async () => {
    const ext = {
      latestSelection: null,
      getSelection: vi.fn().mockResolvedValue({ text: "live", line: 2 }),
    } as any;
    const tool = createGetLatestSelectionTool(ext);
    const result = parse(await tool.handler());
    expect(result.source).toBe("extension");
    expect(result.selection.text).toBe("live");
  });

  it("returns stub when no cache and live returns null", async () => {
    const ext = {
      latestSelection: null,
      getSelection: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createGetLatestSelectionTool(ext);
    const result = parse(await tool.handler());
    expect(result.success).toBe(false);
  });
});

// ── getInlayHints ─────────────────────────────────────────────────────────────

describe("getInlayHints — extension required", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "inlayhints-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const x = 1;\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetInlayHintsTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({
        file: "test.ts",
        startLine: 1,
        endLine: 10,
      }),
    );
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("calls getInlayHints with resolved path and line range", async () => {
    const ext = {
      isConnected: () => true,
      getInlayHints: vi.fn().mockResolvedValue({ hints: [] }),
    } as any;
    const tool = createGetInlayHintsTool(tmpDir, ext);
    const result = parse(
      await tool.handler({ file: "test.ts", startLine: 1, endLine: 5 }),
    );
    expect(ext.getInlayHints).toHaveBeenCalledWith(
      path.join(tmpDir, "test.ts"),
      1,
      5,
    );
    expect(result.hints).toEqual([]);
  });
});

// ── setActiveWorkspaceFolder ──────────────────────────────────────────────────

describe("setActiveWorkspaceFolder", () => {
  it("sets config.activeWorkspaceFolder to resolved path", async () => {
    const config = { activeWorkspaceFolder: null } as any;
    const tool = createSetActiveWorkspaceFolderTool(config);
    const result = parse(await tool.handler({ path: "/tmp/myproject" }));
    expect(result.set).toBe(true);
    expect(config.activeWorkspaceFolder).toBe(path.resolve("/tmp/myproject"));
  });

  it("resolves relative paths against cwd", async () => {
    const config = { activeWorkspaceFolder: null } as any;
    const tool = createSetActiveWorkspaceFolderTool(config);
    await tool.handler({ path: "relative/path" });
    expect(path.isAbsolute(config.activeWorkspaceFolder)).toBe(true);
  });

  it("returns error when path is missing", async () => {
    const config = {} as any;
    const tool = createSetActiveWorkspaceFolderTool(config);
    await expect(tool.handler({})).rejects.toThrow();
  });
});

// ── getTypeHierarchy ──────────────────────────────────────────────────────────

describe("getTypeHierarchy — extension required", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "typehierarchy-")),
    );
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "class Foo {}\n");
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetTypeHierarchyTool(tmpDir, disconnected);
    const result = parse(
      await tool.handler({ file: "test.ts", line: 1, column: 7 }),
    );
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("calls getTypeHierarchy with defaults", async () => {
    const ext = {
      isConnected: () => true,
      getTypeHierarchy: vi
        .fn()
        .mockResolvedValue({ supertypes: [], subtypes: [] }),
    } as any;
    const tool = createGetTypeHierarchyTool(tmpDir, ext);
    await tool.handler({ file: "test.ts", line: 1, column: 7 });
    expect(ext.getTypeHierarchy).toHaveBeenCalledWith(
      path.join(tmpDir, "test.ts"),
      1,
      7,
      "both",
      20,
      undefined,
    );
  });

  it("passes explicit direction and maxResults", async () => {
    const ext = {
      isConnected: () => true,
      getTypeHierarchy: vi.fn().mockResolvedValue({ supertypes: [] }),
    } as any;
    const tool = createGetTypeHierarchyTool(tmpDir, ext);
    await tool.handler({
      file: "test.ts",
      line: 1,
      column: 7,
      direction: "supertypes",
      maxResults: 5,
    });
    expect(ext.getTypeHierarchy).toHaveBeenCalledWith(
      expect.any(String),
      1,
      7,
      "supertypes",
      5,
      undefined,
    );
  });
});

// ── workspaceSettings ─────────────────────────────────────────────────────────

describe("getWorkspaceSettings — extension required", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetWorkspaceSettingsTool(disconnected);
    const result = parse(await tool.handler({}));
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("returns settings from extension", async () => {
    const ext = {
      isConnected: () => true,
      getWorkspaceSettings: vi.fn().mockResolvedValue({ "editor.tabSize": 2 }),
    } as any;
    const tool = createGetWorkspaceSettingsTool(ext);
    const result = parse(
      await tool.handler({ section: "editor", target: "workspace" }),
    );
    expect(ext.getWorkspaceSettings).toHaveBeenCalledWith(
      "editor",
      "workspace",
    );
    expect(result["editor.tabSize"]).toBe(2);
  });
});

describe("setWorkspaceSetting — blocked key prefixes", () => {
  const connected = {
    isConnected: () => true,
    setWorkspaceSetting: vi.fn().mockResolvedValue({ set: true }),
  } as any;

  it.each([
    "security.workspace.trust.enabled",
    "extensions.autoUpdate",
    "extensions.autoInstallDependencies",
    "terminal.integrated.shell",
    "terminal.integrated.shellArgs.linux",
    "terminal.integrated.env.osx",
    "terminal.integrated.profiles.linux",
    "terminal.integrated.defaultProfile.windows",
  ])('blocks write to "%s"', async (key) => {
    const tool = createSetWorkspaceSettingTool(connected);
    const result = parse(await tool.handler({ key, value: "evil" }));
    expect(result.error).toMatch(/blocked/i);
    expect(connected.setWorkspaceSetting).not.toHaveBeenCalled();
  });

  it("allows write to safe keys", async () => {
    const ext = {
      isConnected: () => true,
      setWorkspaceSetting: vi.fn().mockResolvedValue({ set: true }),
    } as any;
    const tool = createSetWorkspaceSettingTool(ext);
    const result = parse(
      await tool.handler({ key: "editor.tabSize", value: 4 }),
    );
    expect(ext.setWorkspaceSetting).toHaveBeenCalledWith(
      "editor.tabSize",
      4,
      undefined,
    );
    expect(result.set).toBe(true);
  });

  it("returns extensionRequired when disconnected", async () => {
    const tool = createSetWorkspaceSettingTool(disconnected);
    const result = parse(
      await tool.handler({ key: "editor.tabSize", value: 4 }),
    );
    expect(result.error).toMatch(/extension.*required|requires.*extension/i);
  });

  it("allows key exactly equal to a blocked prefix (not just startsWith)", async () => {
    // "security" itself should be blocked
    const tool = createSetWorkspaceSettingTool(connected);
    const result = parse(await tool.handler({ key: "security", value: {} }));
    expect(result.error).toMatch(/blocked/i);
  });
});
