import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleGetWorkspaceSettings,
  handleSetWorkspaceSetting,
} from "../../handlers/workspaceSettings";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

describe("handleSetWorkspaceSetting", () => {
  it("throws when key is empty string", async () => {
    await expect(handleSetWorkspaceSetting({ key: "" })).rejects.toThrow(
      "key is required",
    );
  });

  it("throws when key param is missing", async () => {
    await expect(handleSetWorkspaceSetting({})).rejects.toThrow(
      "key is required",
    );
  });

  it("throws for blocked key 'security.anything'", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "security.workspace.trust.enabled" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for exact blocked key 'security'", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "security" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for sub-key of terminal.integrated.shell prefix", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "terminal.integrated.shell.linux" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for blocked key 'terminal.integrated.env'", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "terminal.integrated.env.linux" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for __proto__ key (prototype pollution)", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "__proto__" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for constructor.something key (prototype pollution)", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "constructor.something" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("throws for prototype key (prototype pollution)", async () => {
    await expect(
      handleSetWorkspaceSetting({ key: "prototype.toString" }),
    ).rejects.toThrow("blocked for safety");
  });

  it("calls config.update on a valid key", async () => {
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
      vscode.ConfigurationTarget.Workspace,
    );
    expect(result.set).toBe(true);
    expect(result.key).toBe("editor.tabSize");
  });

  it("uses Workspace target by default", async () => {
    const mockUpdate = vi.fn(async () => {});
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(),
      update: mockUpdate,
    } as any);

    await handleSetWorkspaceSetting({ key: "editor.fontSize", value: 14 });

    expect(mockUpdate).toHaveBeenCalledWith(
      "fontSize",
      14,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it("uses Global target when target='global'", async () => {
    const mockUpdate = vi.fn(async () => {});
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(),
      update: mockUpdate,
    } as any);

    const result = (await handleSetWorkspaceSetting({
      key: "editor.fontSize",
      value: 14,
      target: "global",
    })) as any;

    expect(mockUpdate).toHaveBeenCalledWith(
      "fontSize",
      14,
      vscode.ConfigurationTarget.Global,
    );
    expect(result.target).toBe("global");
  });

  it("handles keys without dots (no section)", async () => {
    const mockUpdate = vi.fn(async () => {});
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(),
      update: mockUpdate,
    } as any);

    await handleSetWorkspaceSetting({ key: "mykey", value: true });

    // section is undefined, settingKey is the whole key
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(undefined);
    expect(mockUpdate).toHaveBeenCalledWith(
      "mykey",
      true,
      vscode.ConfigurationTarget.Workspace,
    );
  });
});

describe("handleGetWorkspaceSettings", () => {
  it("returns section name when section is provided", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    } as any);

    const result = (await handleGetWorkspaceSettings({
      section: "editor",
    })) as any;
    expect(result.section).toBe("editor");
  });

  it("returns '(root)' when no section is provided", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    } as any);

    const result = (await handleGetWorkspaceSettings({})) as any;
    expect(result.section).toBe("(root)");
  });

  it("returns settings object", async () => {
    const mockConfig = {
      tabSize: 2,
      get: vi.fn((key: string) => (key === "tabSize" ? 2 : undefined)),
      inspect: vi.fn((key: string) =>
        key === "tabSize"
          ? {
              defaultValue: 4,
              globalValue: undefined,
              workspaceValue: 2,
              workspaceFolderValue: undefined,
            }
          : undefined,
      ),
      update: vi.fn(),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as any,
    );

    const result = (await handleGetWorkspaceSettings({
      section: "editor",
    })) as any;
    expect(result.settings).toBeDefined();
    expect(result.settings.tabSize).toBeDefined();
    expect(result.settings.tabSize.workspaceValue).toBe(2);
    expect(result.settings.tabSize.defaultValue).toBe(4);
  });
});
