import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createFileWatcherHandlers } from "../../handlers/fileWatcher";
import { Uri, __reset } from "../__mocks__/vscode";

function setup() {
  const sendNotification = vi.fn();
  const deps = {
    getBridge: vi.fn(() => ({ sendNotification })),
  };
  const { handlers, disposeAll } = createFileWatcherHandlers(deps);
  return { handlers, disposeAll, deps, sendNotification };
}

beforeEach(() => {
  __reset();
  vscode.workspace.workspaceFolders = [
    { uri: { fsPath: "/workspace" } },
  ] as any;
});

describe("watchFiles", () => {
  it("watches files successfully", async () => {
    const { handlers } = setup();
    const result = (await handlers["extension/watchFiles"]({
      id: "w1",
      pattern: "**/*.ts",
    })) as any;
    expect(result.watching).toBe(true);
    expect(result.id).toBe("w1");
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
  });

  it("throws when id missing", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/watchFiles"]({ pattern: "**/*.ts" }),
    ).rejects.toThrow("Both 'id' and 'pattern' are required");
  });

  it("throws when pattern missing", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/watchFiles"]({ id: "w1" }),
    ).rejects.toThrow("Both 'id' and 'pattern' are required");
  });

  it("replaces existing watcher with same id", async () => {
    const { handlers } = setup();
    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" });
    const firstWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
      .mock.results[0].value;

    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.js" });
    expect(firstWatcher.dispose).toHaveBeenCalled();
  });

  it("throws when no workspace folder", async () => {
    vscode.workspace.workspaceFolders = undefined;
    const { handlers } = setup();
    await expect(
      handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" }),
    ).rejects.toThrow("No workspace folder open");
  });

  it("throws when bridge not active", async () => {
    const { handlers, deps } = setup();
    deps.getBridge.mockReturnValue(null);
    await expect(
      handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" }),
    ).rejects.toThrow("Bridge not active");
  });

  it("throws when MAX_WATCHERS limit reached", async () => {
    const { handlers } = setup();
    for (let i = 0; i < 10; i++) {
      await handlers["extension/watchFiles"]({
        id: `w${i}`,
        pattern: `**/${i}.ts`,
      });
    }
    await expect(
      handlers["extension/watchFiles"]({ id: "w10", pattern: "**/*.ts" }),
    ).rejects.toThrow("Maximum");
  });

  it("sends notifications on file changes", async () => {
    const { handlers, sendNotification } = setup();
    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" });

    const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock
      .results[0].value;
    const uri = Uri.file("/workspace/new.ts");

    watcher._fire("create", uri);
    expect(sendNotification).toHaveBeenCalledWith("extension/fileChanged", {
      id: "w1",
      type: "created",
      file: "/workspace/new.ts",
    });
  });
});

describe("unwatchFiles", () => {
  it("unwatches existing watcher", async () => {
    const { handlers } = setup();
    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" });
    const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock
      .results[0].value;

    const result = (await handlers["extension/unwatchFiles"]({
      id: "w1",
    })) as any;
    expect(result.unwatched).toBe(true);
    expect(watcher.dispose).toHaveBeenCalled();
  });

  it("throws when watcher not found", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/unwatchFiles"]({ id: "nope" }),
    ).rejects.toThrow("No watcher with this ID");
  });

  it("throws when id missing", async () => {
    const { handlers } = setup();
    await expect(handlers["extension/unwatchFiles"]({})).rejects.toThrow(
      "'id' is required",
    );
  });
});

describe("notify error handling", () => {
  it("swallows errors thrown by sendNotification without propagating", async () => {
    const throwingBridge = {
      sendNotification: vi.fn(() => {
        throw new Error("serialization failure");
      }),
    };
    const deps = {
      getBridge: vi.fn(() => throwingBridge),
    };
    const { handlers } = createFileWatcherHandlers(deps);

    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ] as any;
    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" });

    const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock
      .results[0].value;
    const uri = Uri.file("/workspace/file.ts");

    expect(() => watcher._fire("change", uri)).not.toThrow();
  });
});

describe("disposeAll", () => {
  it("disposes all watchers", async () => {
    const { handlers, disposeAll } = setup();
    await handlers["extension/watchFiles"]({ id: "w1", pattern: "**/*.ts" });
    await handlers["extension/watchFiles"]({ id: "w2", pattern: "**/*.js" });

    const watchers = vi
      .mocked(vscode.workspace.createFileSystemWatcher)
      .mock.results.map((r) => r.value);
    disposeAll();

    for (const w of watchers) {
      expect(w.dispose).toHaveBeenCalled();
    }

    // After dispose, unwatching should throw (watchers cleared)
    await expect(
      handlers["extension/unwatchFiles"]({ id: "w1" }),
    ).rejects.toThrow("No watcher with this ID");
  });
});
