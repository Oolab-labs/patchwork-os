import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode before importing lockfiles
vi.mock("vscode", async () => {
  const mod = await import("./__mocks__/vscode");
  return mod;
});

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

// Mock constants
vi.mock("../constants", () => ({
  LOCK_DIR: "/mock/lock/dir",
}));

import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import { readLockFilesAsync } from "../lockfiles";

const NOW = 1_700_000_000_000; // fixed "now" in ms

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(process, "kill").mockImplementation(() => true as any);
  vi.mocked(fsp.access).mockResolvedValue(undefined as any);
  vi.mocked(fsp.readdir).mockResolvedValue(["12345.lock"] as any);
  vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
  // Set a known workspace so workspace filtering tests are deterministic
  (vscode.workspace as any).workspaceFolders = [
    { uri: { fsPath: "/workspace" } },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeLockContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authToken: "tok-abc",
    pid: 9999,
    workspace: "/some/workspace",
    startedAt: NOW - 60_000, // 1 minute ago — valid by default
    isBridge: true,
    ...overrides,
  });
}

// ── mtime sort ────────────────────────────────────────────────

describe("readLockFilesAsync — mtime sort", () => {
  it("selects the lock file with the newest mtime when multiple exist", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);

    // 22222.lock has newer mtime
    vi.mocked(fsp.stat).mockImplementation(async (p) => {
      if (String(p).includes("22222")) return { mtimeMs: NOW + 1000 } as any;
      return { mtimeMs: NOW } as any;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("22222"))
        return makeLockContent({
          authToken: "newest",
          workspace: "/workspace",
        }) as any;
      return makeLockContent({
        authToken: "oldest",
        workspace: "/workspace",
      }) as any;
    });

    const result = await readLockFilesAsync();
    expect(result?.authToken).toBe("newest");
    expect(result?.port).toBe(22222);
  });

  it("selects the oldest file when it has the newer mtime", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);

    // 11111.lock has newer mtime
    vi.mocked(fsp.stat).mockImplementation(async (p) => {
      if (String(p).includes("11111")) return { mtimeMs: NOW + 2000 } as any;
      return { mtimeMs: NOW } as any;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("11111"))
        return makeLockContent({
          authToken: "newer-mtime",
          workspace: "/workspace",
        }) as any;
      return makeLockContent({
        authToken: "older-mtime",
        workspace: "/workspace",
      }) as any;
    });

    const result = await readLockFilesAsync();
    expect(result?.authToken).toBe("newer-mtime");
    expect(result?.port).toBe(11111);
  });
});

// ── Workspace filtering ───────────────────────────────────────

describe("readLockFilesAsync — workspace filtering", () => {
  it("skips lock file whose workspace does not match current workspace", async () => {
    // __reset() sets workspaceFolders to [{ uri: { fsPath: "/workspace" } }, ...]
    // The lock file has a different workspace
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: "/different/workspace" }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("accepts lock file when workspace matches the current workspace folder", async () => {
    // __reset() sets workspaceFolders[0].uri.fsPath to "/workspace"
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: "/workspace" }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
    expect(result?.authToken).toBe("tok-abc");
  });

  it("accepts lock file when no workspace folders are set", async () => {
    // Override workspaceFolders to undefined — no filtering should occur
    (vscode.workspace as any).workspaceFolders = undefined;

    vi.mocked(fsp.readFile).mockResolvedValue(makeLockContent() as any);
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
  });

  it("accepts lock file when workspaceFolders is empty array", async () => {
    (vscode.workspace as any).workspaceFolders = [];

    vi.mocked(fsp.readFile).mockResolvedValue(makeLockContent() as any);
    const result = await readLockFilesAsync();
    // currentWorkspace will be null (undefined?.[0] is undefined), so no filter applies
    expect(result).not.toBeNull();
  });

  it("accepts lock file when lock file has no workspace field", async () => {
    // Lock content with no workspace — the filtering condition requires BOTH
    // currentWorkspace AND content.workspace to filter
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: undefined }) as any,
    );
    const result = await readLockFilesAsync();
    // workspace is falsy, so filter is skipped — accepted
    expect(result).not.toBeNull();
  });
});

// ── JSON parse failure ────────────────────────────────────────

describe("readLockFilesAsync — JSON parse failure", () => {
  it("skips malformed JSON lock file and tries the next one", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);

    // 11111.lock has newer mtime (so it's tried first) but has bad JSON
    vi.mocked(fsp.stat).mockImplementation(async (p) => {
      if (String(p).includes("11111")) return { mtimeMs: NOW + 1000 } as any;
      return { mtimeMs: NOW } as any;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("11111")) return "NOT VALID JSON {{{" as any;
      return makeLockContent({
        authToken: "good-token",
        workspace: "/workspace",
      }) as any;
    });

    const result = await readLockFilesAsync();
    expect(result?.authToken).toBe("good-token");
  });

  it("returns null when all lock files have malformed JSON", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);
    vi.mocked(fsp.readFile).mockResolvedValue("{{invalid}}" as any);

    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });
});

// ── Missing lock directory ────────────────────────────────────

describe("readLockFilesAsync — missing lock directory", () => {
  it("returns null when lock directory does not exist", async () => {
    vi.mocked(fsp.access).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("returns null when readdir throws unexpectedly", async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(
      new Error("EPERM: permission denied"),
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });
});

// ── Dead PID rejection ────────────────────────────────────────

describe("readLockFilesAsync — dead PID", () => {
  it("rejects lock file with dead PID (ESRCH)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: "/workspace" }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("accepts lock file when PID check throws EPERM (process exists, different user)", async () => {
    // EPERM means process exists but we can't signal it — should be treated as alive
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: "/workspace" }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
  });
});

// ── Non-.lock files filtered ──────────────────────────────────

describe("readLockFilesAsync — file filtering", () => {
  it("ignores non-.lock files in the directory", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "somefile.txt",
      "README.md",
      "12345.lock",
    ] as any);

    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ workspace: "/workspace" }) as any,
    );

    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
    expect(result?.port).toBe(12345);

    // stat should only have been called for .lock files
    const statCalls = vi.mocked(fsp.stat).mock.calls.map((c) => String(c[0]));
    expect(statCalls.every((p) => p.endsWith(".lock"))).toBe(true);
  });

  it("returns null when directory is empty", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([] as any);
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("skips lock files whose basename is not a valid integer port", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue(["notaport.lock"] as any);
    vi.mocked(fsp.readFile).mockResolvedValue(makeLockContent() as any);
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });
});
