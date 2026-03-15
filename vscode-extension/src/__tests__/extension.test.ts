import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { __reset } from "./__mocks__/vscode";

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

vi.mock("vscode");

// Track the most recently created BridgeConnection instance
let lastCreatedBridge: any = null;

vi.mock("../connection", () => ({
  BridgeConnection: vi.fn(() => {
    const instance = {
      output: null as any,
      logLevel: "",
      workspaceOverride: "",
      lockDirOverride: "",
      lockDataFallback: null as any,
      onStateChange: null as any,
      onConnected: null as any,
      startWatchingLockDir: vi.fn(),
      tryConnect: vi.fn(),
      connectDirect: vi.fn(),
      setHandlers: vi.fn(),
      setOnDispose: vi.fn(),
      dispose: vi.fn(),
      log: vi.fn(),
      ws: null,
      claudeConnected: false,
    };
    lastCreatedBridge = instance;
    return instance;
  }),
}));

// Track the most recently created BridgeProcess instance
let lastCreatedProcess: any = null;
const mockSpawn = vi.fn(async () => {});

vi.mock("../bridgeProcess", () => ({
  BridgeProcess: vi.fn(() => {
    const proc = {
      onStarted: null as ((e: any) => void) | null,
      onStartupFailed: null as ((msg: string) => void) | null,
      onStopped: null as (() => void) | null,
      spawn: mockSpawn,
      stop: vi.fn(async () => {}),
      isAlive: vi.fn(() => false),
    };
    lastCreatedProcess = proc;
    return proc;
  }),
}));

// Mock BridgeInstaller
const mockEnsureInstalled = vi.fn(async () => {});
vi.mock("../bridgeInstaller", () => ({
  BridgeInstaller: vi.fn(() => ({ ensureInstalled: mockEnsureInstalled })),
}));

// Mock lockfiles
const mockReadLockFileForWorkspace = vi.fn(async () => null as any);
vi.mock("../lockfiles", () => ({
  readLockFileForWorkspace: (...args: any[]) => mockReadLockFileForWorkspace(...args),
  readAllMatchingLockFiles: vi.fn(async () => []),
}));

// Mock side-effect modules to avoid pulling in all VS Code API surface
vi.mock("../events", () => ({ registerEvents: vi.fn() }));
vi.mock("../handlers/index", () => ({ baseHandlers: {} }));
vi.mock("../handlers/lsp", () => ({ createLspHandlers: vi.fn(() => ({})) }));
vi.mock("../handlers/fileWatcher", () => ({
  createFileWatcherHandlers: vi.fn(() => ({ handlers: {}, disposeAll: vi.fn() })),
}));
vi.mock("../handlers/debug", () => ({
  createDebugHandlers: vi.fn(() => ({ handlers: {}, disposeAll: vi.fn() })),
}));
vi.mock("../handlers/decorations", () => ({
  createDecorationHandlers: vi.fn(() => ({ handlers: {}, disposeAll: vi.fn() })),
}));
vi.mock("../handlers/terminal", () => ({
  clearAllTerminalBuffers: vi.fn(),
}));

// ── Import activate after mocks ────────────────────────────────────────────
import { activate } from "../extension";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => {}),
    },
  } as unknown as vscode.ExtensionContext;
}

/** Wait for all pending microtasks + a setTimeout(0) macrotask */
function flushAsync() {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  __reset();
  vi.clearAllMocks();
  lastCreatedBridge = null;
  lastCreatedProcess = null;
  mockEnsureInstalled.mockResolvedValue(undefined);
  mockSpawn.mockResolvedValue(undefined);
  mockReadLockFileForWorkspace.mockResolvedValue(null);
  (vscode.workspace as any).isTrusted = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("activate() — no workspace folders", () => {
  it("creates a single no-path connection and starts watching", async () => {
    (vscode.workspace as any).workspaceFolders = [];
    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge).not.toBeNull();
    expect(lastCreatedBridge.startWatchingLockDir).toHaveBeenCalled();
    expect(lastCreatedBridge.tryConnect).toHaveBeenCalled();
  });
});

describe("activate() — single workspace folder", () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/home/user/project" } },
    ];
  });

  it("calls tryConnect when a lock file already exists", async () => {
    mockReadLockFileForWorkspace.mockResolvedValue({
      port: 54321,
      authToken: "tok",
      pid: 123,
      workspace: "/home/user/project",
    });

    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge.tryConnect).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns a BridgeProcess when no lock file exists", async () => {
    mockReadLockFileForWorkspace.mockResolvedValue(null);

    activate(makeMockContext());
    await flushAsync();

    expect(mockSpawn).toHaveBeenCalled();
    expect(lastCreatedBridge.tryConnect).not.toHaveBeenCalled();
  });

  it("calls connectDirect via onStarted after successful spawn", async () => {
    mockReadLockFileForWorkspace.mockResolvedValue(null);
    mockSpawn.mockImplementation(async () => {
      lastCreatedProcess?.onStarted?.({ port: 9999, authToken: "abc", pid: 42 });
    });

    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge.connectDirect).toHaveBeenCalledWith(9999, "abc", 42);
  });

  it("calls tryConnect as fallback on onStartupFailed", async () => {
    mockReadLockFileForWorkspace.mockResolvedValue(null);
    mockSpawn.mockImplementation(async () => {
      lastCreatedProcess?.onStartupFailed?.("bridge crashed");
    });

    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge.tryConnect).toHaveBeenCalled();
  });
});

describe("activate() — config flags", () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/home/user/project" } },
    ];
  });

  it("skips spawn when autoStartBridge is false", async () => {
    (vscode.workspace as any).getConfiguration = vi.fn(() => ({
      get: (key: string, def: any) => (key === "autoStartBridge" ? false : def),
    }));

    activate(makeMockContext());
    await flushAsync();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(lastCreatedBridge.tryConnect).toHaveBeenCalled();
  });

  it("skips ensureInstalled when autoInstallBridge is false", async () => {
    (vscode.workspace as any).getConfiguration = vi.fn(() => ({
      get: (key: string, def: any) => (key === "autoInstallBridge" ? false : def),
    }));

    activate(makeMockContext());
    await flushAsync();

    expect(mockEnsureInstalled).not.toHaveBeenCalled();
  });

  it("installer failure is non-fatal — still calls syncConnections", async () => {
    mockEnsureInstalled.mockRejectedValue(new Error("npm not found"));

    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge).not.toBeNull();
    expect(lastCreatedBridge.startWatchingLockDir).toHaveBeenCalled();
  });
});

describe("activate() — untrusted workspace", () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/home/user/project" } },
    ];
    (vscode.workspace as any).isTrusted = false;
  });

  it("skips ensureInstalled in untrusted workspace", async () => {
    activate(makeMockContext());
    await flushAsync();

    expect(mockEnsureInstalled).not.toHaveBeenCalled();
  });

  it("skips spawn in untrusted workspace", async () => {
    activate(makeMockContext());
    await flushAsync();

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("still calls syncConnections — connects to manually-started bridge if lock exists", async () => {
    mockReadLockFileForWorkspace.mockResolvedValue({
      port: 12345,
      authToken: "tok",
      pid: 1,
      workspace: "/home/user/project",
    });

    activate(makeMockContext());
    await flushAsync();

    expect(lastCreatedBridge).not.toBeNull();
    expect(lastCreatedBridge.tryConnect).toHaveBeenCalled();
  });
});
