/**
 * Tests for uncovered extension handler files:
 *   clipboard.ts, inlayHints.ts, typeHierarchy.ts,
 *   validation.ts, vscodeCommands.ts, workspaceSettings.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleReadClipboard,
  handleWriteClipboard,
} from "../../handlers/clipboard";
import { handleGetInlayHints } from "../../handlers/inlayHints";
import { handleGetTypeHierarchy } from "../../handlers/typeHierarchy";
import { requireNumber, requireString } from "../../handlers/validation";
import {
  handleExecuteVSCodeCommand,
  handleListVSCodeCommands,
} from "../../handlers/vscodeCommands";
import {
  handleGetWorkspaceSettings,
  handleSetWorkspaceSetting,
} from "../../handlers/workspaceSettings";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

// ── clipboard ─────────────────────────────────────────────────────────────────

describe("handleReadClipboard", () => {
  it("returns text with byteLength and truncated:false when within limit", async () => {
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue("hello");
    const result = (await handleReadClipboard()) as any;
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
    expect(result.byteLength).toBe(5);
  });

  it("truncates and sets truncated:true when text exceeds 100 KB", async () => {
    const big = "x".repeat(200 * 1024); // 200 KB
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue(big);
    const result = (await handleReadClipboard()) as any;
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(big.length);
    expect(result.byteLength).toBe(Buffer.byteLength(big, "utf-8"));
  });
});

describe("handleWriteClipboard", () => {
  it("writes text and returns written:true with byteLength", async () => {
    const result = (await handleWriteClipboard({ text: "hello" })) as any;
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(result.written).toBe(true);
    expect(result.byteLength).toBe(5);
  });

  it("throws when text is not a string", async () => {
    await expect(handleWriteClipboard({ text: 42 })).rejects.toThrow(/string/i);
  });

  it("throws when text exceeds 1 MB", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    await expect(handleWriteClipboard({ text: big })).rejects.toThrow(
      /too large/i,
    );
  });
});

// ── inlayHints ────────────────────────────────────────────────────────────────

describe("handleGetInlayHints", () => {
  it("throws when file is missing", async () => {
    await expect(handleGetInlayHints({})).rejects.toThrow(/file.*required/i);
  });

  it("throws when startLine is missing", async () => {
    await expect(handleGetInlayHints({ file: "/a.ts" })).rejects.toThrow(
      /startLine.*required/i,
    );
  });

  it("throws when endLine < startLine", async () => {
    await expect(
      handleGetInlayHints({ file: "/a.ts", startLine: 10, endLine: 5 }),
    ).rejects.toThrow(/endLine.*>=.*startLine/i);
  });

  it("returns empty when no hints", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetInlayHints({
      file: "/a.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("serializes hints with 1-based positions and kind mapping", async () => {
    const mockHint = {
      position: { line: 4, character: 7 }, // 0-based → 1-based: line=5, col=8
      label: "number",
      kind: (vscode as any).InlayHintKind.Type,
      tooltip: "a type hint",
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockHint]);
    const result = (await handleGetInlayHints({
      file: "/a.ts",
      startLine: 1,
      endLine: 10,
    })) as any;
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0].position).toEqual({ line: 5, column: 8 });
    expect(result.hints[0].label).toBe("number");
    expect(result.hints[0].kind).toBe("type");
    expect(result.hints[0].tooltip).toBe("a type hint");
  });

  it("serializes parameter kind", async () => {
    const mockHint = {
      position: { line: 0, character: 0 },
      label: "count",
      kind: (vscode as any).InlayHintKind.Parameter,
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockHint]);
    const result = (await handleGetInlayHints({
      file: "/a.ts",
      startLine: 1,
      endLine: 5,
    })) as any;
    expect(result.hints[0].kind).toBe("parameter");
  });

  it("maps label parts array to joined string", async () => {
    const mockHint = {
      position: { line: 0, character: 0 },
      label: [{ value: "foo" }, { value: "bar" }],
      kind: undefined,
    };
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockHint]);
    const result = (await handleGetInlayHints({
      file: "/a.ts",
      startLine: 1,
      endLine: 5,
    })) as any;
    expect(result.hints[0].label).toBe("foobar");
  });

  it("returns empty with message when executeCommand throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("no provider"),
    );
    const result = (await handleGetInlayHints({
      file: "/a.ts",
      startLine: 1,
      endLine: 5,
    })) as any;
    expect(result.hints).toEqual([]);
    expect(result.message).toMatch(/unavailable/i);
  });
});

// ── typeHierarchy ─────────────────────────────────────────────────────────────

describe("handleGetTypeHierarchy", () => {
  it("throws when file is missing", async () => {
    await expect(handleGetTypeHierarchy({})).rejects.toThrow(/file.*required/i);
  });

  it("throws when line is missing", async () => {
    await expect(handleGetTypeHierarchy({ file: "/a.ts" })).rejects.toThrow(
      /line.*required/i,
    );
  });

  it("returns found:false when prepareTypeHierarchy returns empty", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);
    const result = (await handleGetTypeHierarchy({
      file: "/a.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.found).toBe(false);
  });

  it("returns found:false when prepareTypeHierarchy throws", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("unavail"),
    );
    const result = (await handleGetTypeHierarchy({
      file: "/a.ts",
      line: 1,
      column: 1,
    })) as any;
    expect(result.found).toBe(false);
    expect(result.message).toMatch(/unavailable/i);
  });

  it("returns root and supertypes/subtypes when found", async () => {
    const rootItem = {
      name: "Animal",
      kind: 4, // Class
      uri: { fsPath: "/animal.ts" },
      selectionRange: { start: { line: 2, character: 6 } },
    };
    const parentItem = {
      name: "Base",
      kind: 4,
      uri: { fsPath: "/base.ts" },
      selectionRange: { start: { line: 0, character: 0 } },
    };
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem]) // prepareTypeHierarchy
      .mockResolvedValueOnce([parentItem]) // provideSupertypes
      .mockResolvedValueOnce([]); // provideSubtypes

    const result = (await handleGetTypeHierarchy({
      file: "/animal.ts",
      line: 3,
      column: 7,
    })) as any;
    expect(result.found).toBe(true);
    expect(result.root.name).toBe("Animal");
    expect(result.root.line).toBe(3); // 2 + 1
    expect(result.root.column).toBe(7); // 6 + 1
    expect(result.supertypes).toHaveLength(1);
    expect(result.supertypes[0].name).toBe("Base");
    expect(result.subtypes).toHaveLength(0);
    expect(result.direction).toBe("both");
  });

  it("only fetches supertypes when direction=supertypes", async () => {
    const rootItem = {
      name: "Foo",
      kind: 4,
      uri: { fsPath: "/foo.ts" },
      selectionRange: { start: { line: 0, character: 0 } },
    };
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem])
      .mockResolvedValueOnce([]);

    const result = (await handleGetTypeHierarchy({
      file: "/foo.ts",
      line: 1,
      column: 1,
      direction: "supertypes",
    })) as any;
    expect(result.found).toBe(true);
    expect(result.subtypes).toHaveLength(0);
    // executeCommand called twice: prepare + provideSupertypes (no provideSubtypes)
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("respects maxResults cap", async () => {
    const rootItem = {
      name: "Root",
      kind: 4,
      uri: { fsPath: "/r.ts" },
      selectionRange: { start: { line: 0, character: 0 } },
    };
    const manyChildren = Array.from({ length: 10 }, (_, i) => ({
      name: `Child${i}`,
      kind: 4,
      uri: { fsPath: `/c${i}.ts` },
      selectionRange: { start: { line: 0, character: 0 } },
    }));
    vi.mocked(vscode.commands.executeCommand)
      .mockResolvedValueOnce([rootItem])
      .mockResolvedValueOnce([]) // supertypes
      .mockResolvedValueOnce(manyChildren); // subtypes

    const result = (await handleGetTypeHierarchy({
      file: "/r.ts",
      line: 1,
      column: 1,
      maxResults: 3,
    })) as any;
    expect(result.subtypes).toHaveLength(3);
  });
});

// ── validation ────────────────────────────────────────────────────────────────

describe("requireString", () => {
  it("returns the string when valid", () => {
    expect(requireString("hello", "name")).toBe("hello");
  });

  it("throws when value is not a string", () => {
    expect(() => requireString(42, "field")).toThrow(/field.*required/i);
  });

  it("throws when value is empty string", () => {
    expect(() => requireString("", "field")).toThrow(/field.*required/i);
  });
});

describe("requireNumber", () => {
  it("returns the number when valid", () => {
    expect(requireNumber(7, "count")).toBe(7);
  });

  it("throws when value is not a number", () => {
    expect(() => requireNumber("7", "count")).toThrow(/count.*required/i);
  });

  it("throws when value is Infinity", () => {
    expect(() => requireNumber(Number.POSITIVE_INFINITY, "count")).toThrow(
      /count.*required/i,
    );
  });

  it("throws when value is NaN", () => {
    expect(() => requireNumber(Number.NaN, "count")).toThrow(
      /count.*required/i,
    );
  });
});

// ── vscodeCommands ────────────────────────────────────────────────────────────

describe("handleExecuteVSCodeCommand", () => {
  it("throws when command is missing", async () => {
    await expect(handleExecuteVSCodeCommand({})).rejects.toThrow(
      /command.*required/i,
    );
  });

  it("throws when command is empty string", async () => {
    await expect(handleExecuteVSCodeCommand({ command: "" })).rejects.toThrow(
      /command.*required/i,
    );
  });

  it("executes command and returns serialized result", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue({
      items: [1, 2],
    });
    const result = (await handleExecuteVSCodeCommand({
      command: "editor.action.foo",
    })) as any;
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "editor.action.foo",
    );
    expect(result.result).toEqual({ items: [1, 2] });
  });

  it("spreads args array when provided", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    await handleExecuteVSCodeCommand({ command: "myCmd", args: ["a", "b"] });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "myCmd",
      "a",
      "b",
    );
  });

  it("wraps executeCommand errors with command name", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("not found"),
    );
    await expect(
      handleExecuteVSCodeCommand({ command: "bad.cmd" }),
    ).rejects.toThrow(/bad\.cmd.*not found/i);
  });

  it("returns null result as null (not undefined)", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = (await handleExecuteVSCodeCommand({
      command: "cmd",
    })) as any;
    expect(result.result).toBeNull();
  });

  it("returns string fallback and _warning when result is non-JSON-serializable", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(circular);
    const result = (await handleExecuteVSCodeCommand({
      command: "cmd.circular",
    })) as any;
    expect(typeof result.result).toBe("string");
    expect(result._warning).toMatch(/not JSON-serializable/i);
  });
});

describe("handleListVSCodeCommands", () => {
  it("returns all commands when no filter", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([
      "editor.action.foo",
      "workbench.action.bar",
    ]);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.commands).toEqual([
      "editor.action.foo",
      "workbench.action.bar",
    ]);
    expect(result.total).toBe(2);
    expect(result.capped).toBe(false);
  });

  it("filters commands by substring (case-insensitive)", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([
      "editor.action.goToDefinition",
      "workbench.action.openFile",
      "editor.action.rename",
    ]);
    const result = (await handleListVSCodeCommands({
      filter: "EDITOR",
    })) as any;
    expect(result.commands).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("sets capped:true when results exceed MAX_COMMANDS", async () => {
    const many = Array.from({ length: 2100 }, (_, i) => `cmd.${i}`);
    vi.mocked(vscode.commands.getCommands).mockResolvedValue(many);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.capped).toBe(true);
    expect(result.commands).toHaveLength(2000);
    expect(result.total).toBe(2100);
  });
});

// ── workspaceSettings ─────────────────────────────────────────────────────────

describe("handleGetWorkspaceSettings", () => {
  it("returns section and settings object", async () => {
    const mockConfig = {
      get: vi.fn((key: string, _default: unknown) => {
        if (key === "tabSize") return 4;
        return _default;
      }),
      inspect: vi.fn((key: string) => {
        if (key === "tabSize")
          return { defaultValue: 4, globalValue: undefined, workspaceValue: 4 };
        return undefined;
      }),
      tabSize: 4,
      update: vi.fn(),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as any,
    );

    const result = (await handleGetWorkspaceSettings({
      section: "editor",
    })) as any;
    expect(result.section).toBe("editor");
    expect(result.settings.tabSize).toBeDefined();
    expect(result.settings.tabSize.value).toBe(4);
  });

  it("uses (root) when no section provided", async () => {
    const result = (await handleGetWorkspaceSettings({})) as any;
    expect(result.section).toBe("(root)");
  });
});

describe("handleSetWorkspaceSetting", () => {
  it("throws when key is missing", async () => {
    await expect(handleSetWorkspaceSetting({})).rejects.toThrow(
      /key.*required/i,
    );
  });

  it.each([
    "security.workspace.trust.enabled",
    "extensions.autoUpdate",
    "extensions.autoInstallDependencies",
    "terminal.integrated.shell",
    "terminal.integrated.shellArgs.linux",
    "terminal.integrated.env.osx",
    "terminal.integrated.profiles.linux",
    "terminal.integrated.defaultProfile.windows",
    "security", // blocked prefix itself
  ])('blocks write to "%s"', async (key) => {
    await expect(
      handleSetWorkspaceSetting({ key, value: "evil" }),
    ).rejects.toThrow(/blocked/i);
  });

  it("blocks prototype pollution keys", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "__proto__.evil", value: 1 }),
    ).rejects.toThrow(/blocked/i);
  });

  it("calls config.update for safe keys and returns set:true", async () => {
    const mockUpdate = vi.fn(async () => {});
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(),
      update: mockUpdate,
    } as any);

    const result = (await handleSetWorkspaceSetting({
      key: "editor.tabSize",
      value: 4,
    })) as any;
    expect(mockUpdate).toHaveBeenCalledWith(
      "tabSize",
      4,
      (vscode as any).ConfigurationTarget.Workspace,
    );
    expect(result.set).toBe(true);
    expect(result.key).toBe("editor.tabSize");
  });

  it("uses Global target when target='global'", async () => {
    const mockUpdate = vi.fn(async () => {});
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(),
      update: mockUpdate,
    } as any);

    await handleSetWorkspaceSetting({
      key: "editor.fontSize",
      value: 14,
      target: "global",
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      "fontSize",
      14,
      (vscode as any).ConfigurationTarget.Global,
    );
  });
});
