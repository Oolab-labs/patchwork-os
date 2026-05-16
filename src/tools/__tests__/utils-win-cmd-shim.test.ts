/**
 * Regression test: execSafe + execSafeStreaming must wrap their binary
 * argument with ensureCmdShim so npm-installed `.cmd` shims (npm, npx,
 * tsc, biome, rg, …) resolve under shell:false on Windows.
 *
 * Without the wrap, ~150 callers of these helpers silently ENOENT on
 * Windows even though the same commands work fine in a terminal.
 *
 * vi.mock + isolate the spawn intercept in this file so other suites
 * keep their real child_process.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb: (
      err: NodeJS.ErrnoException | null,
      out?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    execFileMock(cmd, args, opts);
    // execFile's promisified form passes the callback when no options object
    // is split out. Always invoke synchronously with a fake success so the
    // promise resolves and we can read the spy.
    cb(null, { stdout: "", stderr: "" });
  },
  spawn: (cmd: string, args: readonly string[], opts: unknown) => {
    spawnMock(cmd, args, opts);
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, handler: (...a: unknown[]) => void) => {
        if (event === "close") setTimeout(() => handler(0), 0);
      },
      kill: () => {},
    };
  },
}));

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

// Import AFTER vi.mock so the mock applies to the helper's internal binding.
const { execSafe, execSafeStreaming } = await import("../utils.js");

describe("execSafe — .cmd-shim wrap on Windows", () => {
  beforeAll(() => setPlatform("win32"));
  afterAll(() => {
    setPlatform(ORIG_PLATFORM);
    vi.resetAllMocks();
  });

  it("wraps a bare binary name with .cmd before invoking execFile", async () => {
    execFileMock.mockClear();
    await execSafe("npm", ["--version"], { allowlistChecked: true });
    expect(execFileMock).toHaveBeenCalled();
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("npm.cmd");
  });

  it("leaves an explicit .exe path alone", async () => {
    execFileMock.mockClear();
    await execSafe("C:/Tools/foo.exe", [], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("C:/Tools/foo.exe");
  });
});

describe("execSafeStreaming — .cmd-shim wrap on Windows", () => {
  beforeAll(() => setPlatform("win32"));
  afterAll(() => {
    setPlatform(ORIG_PLATFORM);
    vi.resetAllMocks();
  });

  it("wraps a bare binary name with .cmd before invoking spawn", async () => {
    spawnMock.mockClear();
    await execSafeStreaming("rg", ["foo"], {
      allowlistChecked: true,
      onLine: () => {},
    });
    expect(spawnMock).toHaveBeenCalled();
    const [cmd] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("rg.cmd");
  });
});

describe("execSafe — non-Windows is a no-op wrap", () => {
  beforeAll(() => setPlatform("linux"));
  afterAll(() => {
    setPlatform(ORIG_PLATFORM);
    vi.resetAllMocks();
  });

  it("leaves the binary name unchanged on non-Windows", async () => {
    execFileMock.mockClear();
    await execSafe("npm", ["--version"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("npm");
  });
});
