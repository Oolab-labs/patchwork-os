/**
 * Regression test: execSafe + execSafeStreaming must wrap known npm `.cmd`
 * shims (npm, npx, tsc, biome, …) so they resolve under shell:false on
 * Windows. Equally important — they must NOT wrap system binaries like
 * `git` (resolved as git.exe via PATHEXT) or shell tools like `echo`,
 * because `spawn("git.cmd")` ENOENTs on Windows.
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

describe("execSafe — Windows .cmd-shim wrap (known shims only)", () => {
  beforeAll(() => setPlatform("win32"));
  afterAll(() => {
    setPlatform(ORIG_PLATFORM);
    vi.resetAllMocks();
  });

  it("WRAPS known npm shims (npm → npm.cmd)", async () => {
    execFileMock.mockClear();
    await execSafe("npm", ["--version"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("npm.cmd");
  });

  it("WRAPS tsc → tsc.cmd (npm-installed dev tool)", async () => {
    execFileMock.mockClear();
    await execSafe("tsc", ["--version"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("tsc.cmd");
  });

  it("LEAVES system binaries alone — git stays git, not git.cmd", async () => {
    execFileMock.mockClear();
    await execSafe("git", ["--version"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("git");
  });

  it("LEAVES shell-builtin-ish binaries alone — echo stays echo", async () => {
    execFileMock.mockClear();
    await execSafe("echo", ["hello"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("echo");
  });

  it("LEAVES rg alone — install source is ambiguous, omitted from known set", async () => {
    execFileMock.mockClear();
    await execSafe("rg", ["foo"], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("rg");
  });

  it("LEAVES an explicit .exe path alone", async () => {
    execFileMock.mockClear();
    await execSafe("C:/Tools/foo.exe", [], { allowlistChecked: true });
    const [cmd] = execFileMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("C:/Tools/foo.exe");
  });
});

describe("execSafeStreaming — Windows .cmd-shim wrap (known shims only)", () => {
  beforeAll(() => setPlatform("win32"));
  afterAll(() => {
    setPlatform(ORIG_PLATFORM);
    vi.resetAllMocks();
  });

  it("WRAPS known shim — eslint → eslint.cmd", async () => {
    spawnMock.mockClear();
    await execSafeStreaming("eslint", ["src"], {
      allowlistChecked: true,
      onLine: () => {},
    });
    const [cmd] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("eslint.cmd");
  });

  it("LEAVES git alone", async () => {
    spawnMock.mockClear();
    await execSafeStreaming("git", ["log"], {
      allowlistChecked: true,
      onLine: () => {},
    });
    const [cmd] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("git");
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
