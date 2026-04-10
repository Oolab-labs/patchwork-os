import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleExecuteVSCodeCommand,
  handleListVSCodeCommands,
} from "../../handlers/vscodeCommands";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

describe("handleExecuteVSCodeCommand", () => {
  it("throws when command is an empty string", async () => {
    await expect(handleExecuteVSCodeCommand({ command: "" })).rejects.toThrow(
      "command is required",
    );
  });

  it("throws when command param is missing", async () => {
    await expect(handleExecuteVSCodeCommand({})).rejects.toThrow(
      "command is required",
    );
  });

  it("throws when command is not a string", async () => {
    await expect(handleExecuteVSCodeCommand({ command: 42 })).rejects.toThrow(
      "command is required",
    );
  });

  it("executes the command with no args by default", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue("ok");
    await handleExecuteVSCodeCommand({ command: "editor.action.format" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "editor.action.format",
    );
  });

  it("passes args array to executeCommand", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await handleExecuteVSCodeCommand({
      command: "myCmd",
      args: ["arg1", 2],
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "myCmd",
      "arg1",
      2,
    );
  });

  it("returns serialized result", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue({
      count: 3,
      name: "test",
    });
    const result = (await handleExecuteVSCodeCommand({
      command: "myCmd",
    })) as any;
    expect(result.result).toEqual({ count: 3, name: "test" });
  });

  it("returns null result when command resolves undefined", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = (await handleExecuteVSCodeCommand({
      command: "myCmd",
    })) as any;
    expect(result.result).toBeNull();
  });

  it("re-throws with descriptive message when command fails", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      new Error("command not found"),
    );
    await expect(
      handleExecuteVSCodeCommand({ command: "bad.cmd" }),
    ).rejects.toThrow('Command "bad.cmd" failed: command not found');
  });

  it("sets _warning for non-JSON-serializable result", async () => {
    // A circular object cannot be JSON.stringified
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(circular);
    const result = (await handleExecuteVSCodeCommand({
      command: "myCmd",
    })) as any;
    expect(result._warning).toMatch(/not JSON-serializable/i);
  });

  it("ignores non-array args and uses empty array", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(null);
    await handleExecuteVSCodeCommand({ command: "myCmd", args: "notAnArray" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("myCmd");
  });
});

describe("handleListVSCodeCommands", () => {
  it("returns all commands when no filter provided", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([
      "editor.action.format",
      "workbench.action.files.save",
    ]);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.commands).toEqual([
      "editor.action.format",
      "workbench.action.files.save",
    ]);
    expect(result.total).toBe(2);
    expect(result.capped).toBe(false);
  });

  it("filters by substring case-insensitively", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([
      "editor.action.formatDocument",
      "workbench.action.files.save",
      "Editor.selectAll",
    ]);
    const result = (await handleListVSCodeCommands({
      filter: "EDITOR",
    })) as any;
    expect(result.commands).toEqual([
      "editor.action.formatDocument",
      "Editor.selectAll",
    ]);
    expect(result.total).toBe(2);
  });

  it("returns capped=true when more than 2000 commands match", async () => {
    const manyCommands = Array.from({ length: 2500 }, (_, i) => `cmd.${i}`);
    vi.mocked(vscode.commands.getCommands).mockResolvedValue(manyCommands);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.commands).toHaveLength(2000);
    expect(result.total).toBe(2500);
    expect(result.capped).toBe(true);
  });

  it("returns capped=false when exactly at or under 2000 commands", async () => {
    const exactCommands = Array.from({ length: 2000 }, (_, i) => `cmd.${i}`);
    vi.mocked(vscode.commands.getCommands).mockResolvedValue(exactCommands);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.commands).toHaveLength(2000);
    expect(result.capped).toBe(false);
  });

  it("returns empty commands array when no commands exist", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([]);
    const result = (await handleListVSCodeCommands({})) as any;
    expect(result.commands).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.capped).toBe(false);
  });
});
