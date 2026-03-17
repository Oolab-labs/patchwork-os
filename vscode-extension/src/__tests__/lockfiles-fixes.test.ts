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

vi.mock("../constants", () => ({
  LOCK_DIR: "/mock/lock/dir",
}));

import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import {
  readLockFilesAsync,
  readLockFileForWorkspace,
} from "../lockfiles";

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(process, "kill").mockImplementation(() => true as any);
  vi.mocked(fsp.access).mockResolvedValue(undefined as any);
  vi.mocked(fsp.readdir).mockResolvedValue(["12345.lock"] as any);
  vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
  (vscode.workspace as any).workspaceFolders = [
    { uri: { fsPath: "/workspace" } },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeLock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authToken: "tok",
    pid: 9999,
    workspace: "/workspace",
    startedAt: NOW - 60_000,
    isBridge: true,
    ...overrides,
  });
}

// ── Bug #1: isBridge filter ───────────────────────────────────────────────────

describe("readValidLockFiles — isBridge filter (bug #1)", () => {
  it("rejects an IDE-owned lock (no isBridge field) in readLockFilesAsync", async () => {
    // Windsurf's own lock file — no isBridge field
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLock({ isBridge: undefined }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("rejects an IDE-owned lock (isBridge=false) in readLockFilesAsync", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLock({ isBridge: false }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("accepts a bridge lock (isBridge=true) in readLockFilesAsync", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(makeLock({ isBridge: true }) as any);
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
    expect(result?.authToken).toBe("tok");
  });

  it("rejects an IDE-owned lock in readLockFileForWorkspace", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLock({ isBridge: undefined }) as any,
    );
    const result = await readLockFileForWorkspace("/workspace");
    expect(result).toBeNull();
  });

  it("prefers bridge lock over IDE lock when both exist", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);
    vi.mocked(fsp.stat).mockImplementation(async (p) => {
      // IDE lock is newer — should still be skipped
      if (String(p).includes("11111")) return { mtimeMs: NOW + 1000 } as any;
      return { mtimeMs: NOW } as any;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("11111"))
        // Newer but no isBridge — IDE lock
        return makeLock({ authToken: "ide-lock", isBridge: undefined }) as any;
      return makeLock({ authToken: "bridge-lock", isBridge: true }) as any;
    });
    const result = await readLockFilesAsync();
    expect(result?.authToken).toBe("bridge-lock");
  });
});

// ── Bug #2: EPERM treated as alive ───────────────────────────────────────────

describe("readValidLockFiles — EPERM handling (bug #2)", () => {
  it("treats EPERM as alive (bridge running as different user)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    vi.mocked(fsp.readFile).mockResolvedValue(makeLock() as any);
    const result = await readLockFilesAsync();
    // EPERM → process exists but different user → should be accepted
    expect(result).not.toBeNull();
    expect(result?.authToken).toBe("tok");
  });

  it("still rejects ESRCH (process truly dead)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    vi.mocked(fsp.readFile).mockResolvedValue(makeLock() as any);
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });
});
