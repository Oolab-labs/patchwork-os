import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(async (_opts: unknown, task: () => Promise<void>) => task()),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  ProgressLocation: { Window: 10 },
}));

// Mock child_process.execFile (used via promisify)
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execFile: vi.fn(),
  };
});

// Inject BRIDGE_VERSION global before importing BridgeInstaller
(globalThis as Record<string, unknown>).BRIDGE_VERSION = "2.0.1";

import { execFile } from "node:child_process";
import { BridgeInstaller } from "../bridgeInstaller";
import * as vscode from "vscode";

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Helper: make execFile call its callback with stdout
function mockExec(stdout: string, stderr = "", code = 0) {
  mockedExecFile.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      if (code === 0) cb(null, { stdout, stderr });
      else cb(new Error(stderr || "exec failed"), { stdout: "", stderr });
    },
  );
}

let output: { appendLine: ReturnType<typeof vi.fn> };
let installer: BridgeInstaller;

beforeEach(() => {
  output = { appendLine: vi.fn() };
  installer = new BridgeInstaller(output as unknown as import("vscode").OutputChannel);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BridgeInstaller.getInstalledVersion", () => {
  it("returns semver from claude-ide-bridge --version output", async () => {
    mockExec("claude-ide-bridge 2.0.0\n");
    const v = await installer.getInstalledVersion();
    expect(v).toBe("2.0.0");
  });

  it("returns null when binary not found", async () => {
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    const v = await installer.getInstalledVersion();
    expect(v).toBeNull();
  });
});

describe("BridgeInstaller.getRequiredVersion", () => {
  it("returns the injected BRIDGE_VERSION", () => {
    expect(installer.getRequiredVersion()).toBe("2.0.1");
  });
});

describe("BridgeInstaller.ensureInstalled", () => {
  it("is a no-op when installed version matches required", async () => {
    // getInstalledVersion returns 2.0.1 (matches BRIDGE_VERSION)
    mockExec("2.0.1\n");
    await installer.ensureInstalled();
    // npm install should NOT have been called
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][0]).toBe("claude-ide-bridge");
  });

  it("calls npm install when bridge is not installed", async () => {
    // getInstalledVersion → null (not found)
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    // npm install succeeds
    mockExec("", "", 0);

    await installer.ensureInstalled();

    expect(mockedExecFile).toHaveBeenCalledTimes(2);
    const npmCall = mockedExecFile.mock.calls[1];
    expect(npmCall[0]).toMatch(/npm/);
    expect(npmCall[1]).toContain("install");
    expect(npmCall[1]).toContain("-g");
    expect(npmCall[1].some((a: string) => a.includes("2.0.1"))).toBe(true);
  });

  it("calls npm install when installed version is outdated", async () => {
    mockExec("1.9.0\n"); // outdated
    mockExec("", "", 0); // npm install succeeds

    await installer.ensureInstalled();

    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it("shows warning when npm is not found", async () => {
    // getInstalledVersion → null
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    // npm install → ENOENT
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = new Error("ENOENT: npm not found");
        cb(err, { stdout: "", stderr: "" });
      },
    );

    await expect(installer.ensureInstalled()).rejects.toThrow();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
