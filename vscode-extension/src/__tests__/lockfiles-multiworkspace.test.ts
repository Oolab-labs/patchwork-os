/**
 * Tests for multi-workspace lockfile functions:
 * - readLockFileForWorkspace
 * - readAllMatchingLockFiles
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => {
  const mod = await import("./__mocks__/vscode");
  return mod;
});

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../constants", () => {
  const p = require("node:path") as typeof import("node:path");
  return { LOCK_DIR: p.resolve("/mock/lock/dir") };
});

const CUSTOM_LOCK_DIR = path.resolve("/custom/lock");

import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import {
  readAllMatchingLockFiles,
  readLockFileForWorkspace,
} from "../lockfiles";

const NOW = 1_700_000_000_000;

const WS_A = path.resolve("/project/a");
const WS_B = path.resolve("/project/b");
const WS_C = path.resolve("/project/c");
const WS_UNKNOWN = path.resolve("/project/unknown");
const WS_SOME = path.resolve("/some/ws");

function makeLockContent(
  workspace: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    authToken: "tok-abc",
    pid: 9999,
    workspace,
    startedAt: NOW - 60_000,
    isBridge: true,
    ...overrides,
  });
}

function setupLocks(
  locks: Array<{
    file: string;
    workspace: string;
    overrides?: Record<string, unknown>;
  }>,
): void {
  vi.mocked(fsp.readdir).mockResolvedValue(locks.map((l) => l.file) as any);
  vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const file = path.basename(String(p));
    const lock = locks.find((l) => l.file === file);
    if (!lock) throw new Error(`ENOENT: ${String(p)}`);
    return makeLockContent(lock.workspace, lock.overrides ?? {}) as any;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(process, "kill").mockImplementation(() => true as any);
  vi.mocked(fsp.access).mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── readLockFileForWorkspace ──────────────────────────────────────────────────

describe("readLockFileForWorkspace", () => {
  it("returns the lock file matching the specified workspace", async () => {
    setupLocks([
      { file: "10001.lock", workspace: WS_A },
      { file: "10002.lock", workspace: WS_B },
    ]);
    const result = await readLockFileForWorkspace(WS_B);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(10002);
    expect(result!.workspace).toBe(WS_B);
  });

  it("returns null when no lock file matches", async () => {
    setupLocks([{ file: "10001.lock", workspace: WS_A }]);
    const result = await readLockFileForWorkspace(WS_UNKNOWN);
    expect(result).toBeNull();
  });

  it("resolves symlink-style paths correctly (both resolved)", async () => {
    setupLocks([{ file: "10001.lock", workspace: WS_A }]);
    // The function uses path.resolve() on both sides
    const result = await readLockFileForWorkspace(
      path.join(path.resolve("/project"), ".", "a"),
    );
    expect(result).not.toBeNull();
    expect(result!.port).toBe(10001);
  });

  it("skips expired lock files", async () => {
    setupLocks([
      {
        file: "10001.lock",
        workspace: WS_A,
        overrides: { startedAt: NOW - 25 * 60 * 60 * 1000 }, // 25h ago — beyond 24h threshold
      },
    ]);
    const result = await readLockFileForWorkspace(WS_A);
    expect(result).toBeNull();
  });

  it("uses the provided lockDir override", async () => {
    vi.mocked(fsp.access).mockImplementation(async (p) => {
      if (String(p) !== CUSTOM_LOCK_DIR) throw new Error("ENOENT");
    });
    setupLocks([{ file: "10001.lock", workspace: WS_A }]);
    const result = await readLockFileForWorkspace(WS_A, CUSTOM_LOCK_DIR);
    // Access check passes for CUSTOM_LOCK_DIR; file lookup succeeds
    expect(result).not.toBeNull();
  });
});

// ── readAllMatchingLockFiles ──────────────────────────────────────────────────

describe("readAllMatchingLockFiles", () => {
  it("returns one lock per workspace folder", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: WS_A } },
      { uri: { fsPath: WS_B } },
    ];
    setupLocks([
      { file: "10001.lock", workspace: WS_A },
      { file: "10002.lock", workspace: WS_B },
    ]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.port).sort()).toEqual([10001, 10002]);
  });

  it("omits workspace folders with no matching bridge", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: WS_A } },
      { uri: { fsPath: WS_C } }, // no bridge
    ];
    setupLocks([{ file: "10001.lock", workspace: WS_A }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(10001);
  });

  it("deduplicates: same port appears only once even if matched by two folders", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: WS_A } },
      { uri: { fsPath: WS_A } }, // duplicate
    ];
    setupLocks([{ file: "10001.lock", workspace: WS_A }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
  });

  it("returns the newest available lock when no workspace folders are open", async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    setupLocks([{ file: "10001.lock", workspace: WS_SOME }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(10001);
  });

  it("returns empty array when no workspace folders and no lock files", async () => {
    (vscode.workspace as any).workspaceFolders = [];
    vi.mocked(fsp.readdir).mockResolvedValue([] as any);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(0);
  });
});

// ── Windows drive-letter/case-insensitivity ──────────────────────────────────

describe("cross-platform workspace-path matching", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("readLockFileForWorkspace matches a drive-letter-case mismatch on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    setupLocks([{ file: "10001.lock", workspace: "C:\\Users\\dev\\repo" }]);
    // VS Code-style lowercase drive letter + forward slashes.
    const result = await readLockFileForWorkspace("c:/users/dev/repo");
    expect(result).not.toBeNull();
    expect(result!.port).toBe(10001);
  });

  it("readLockFileForWorkspace does NOT fold case on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    setupLocks([{ file: "10001.lock", workspace: "/Project/A" }]);
    const result = await readLockFileForWorkspace("/project/a");
    expect(result).toBeNull();
  });

  it("readAllMatchingLockFiles matches drive-letter-case mismatches on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "c:/users/dev/repo" } },
    ];
    setupLocks([{ file: "10001.lock", workspace: "C:\\Users\\dev\\repo" }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(10001);
  });
});
