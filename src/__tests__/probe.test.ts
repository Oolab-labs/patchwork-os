import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process before importing the module under test
vi.mock("node:child_process", () => {
  const original =
    vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFile: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import type { ProbeResults } from "../probe.js";

// We need to dynamically import probeAll after mocking
const { probeAll } = await import("../probe.js");

const mockedExecFile = vi.mocked(execFile);

const ALL_KEYS: Array<keyof ProbeResults> = [
  "rg",
  "fd",
  "git",
  "gh",
  "tsc",
  "eslint",
  "pyright",
  "ruff",
  "cargo",
  "go",
  "biome",
  "prettier",
  "black",
  "gofmt",
  "rustfmt",
  "vitest",
  "jest",
  "pytest",
  "codex",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeAll", () => {
  it("returns all keys from ProbeResults", async () => {
    // Make all probes succeed
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "/usr/bin/test",
          "",
        );
      }
      return undefined as never;
    });

    const result = await probeAll();
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([...ALL_KEYS].sort());
  });

  it("returns false for a command not found without throwing", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    const result = await probeAll();
    // All should be false, but no error thrown
    for (const key of ALL_KEYS) {
      expect(result[key]).toBe(false);
    }
  });

  it("calls execFile for each command in COMMANDS", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "/usr/bin/test",
          "",
        );
      }
      return undefined as never;
    });

    await probeAll();

    // execFile should have been called once for each command
    expect(mockedExecFile).toHaveBeenCalledTimes(ALL_KEYS.length);

    // Verify each command was probed via "which"
    const calledCommands = mockedExecFile.mock.calls.map(
      (call) => (call[1] as string[])[0],
    );
    for (const key of ALL_KEYS) {
      expect(calledCommands).toContain(key);
    }
  });

  it("returns false when a probe times out", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("timed out") as NodeJS.ErrnoException & {
          killed: boolean;
        };
        err.killed = true;
        err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    const result = await probeAll();
    for (const key of ALL_KEYS) {
      expect(result[key]).toBe(false);
    }
  });
});

describe("probeAll — local node_modules/.bin fallback", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import(
      "node:fs"
    );
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    tmpDir = mkdtempSync(join(tmpdir(), "probe-test-"));
    const binDir = join(tmpDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // Create a fake local tsc binary
    writeFileSync(join(binDir, "tsc"), "#!/bin/sh\necho ok");
    chmodSync(join(binDir, "tsc"), 0o755);
    // Create a fake local biome binary
    writeFileSync(join(binDir, "biome"), "#!/bin/sh\necho ok");
    chmodSync(join(binDir, "biome"), 0o755);
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("detects tsc from local node_modules/.bin when not on global PATH", async () => {
    // which/where always fails (not on global PATH)
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    const result = await probeAll(tmpDir);
    expect(result.tsc).toBe(true);
  });

  it("detects biome from local node_modules/.bin when not on global PATH", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    const result = await probeAll(tmpDir);
    expect(result.biome).toBe(true);
  });

  it("non-JS tools (e.g. rg) are NOT detected via local node_modules/.bin", async () => {
    // which always fails, and rg is not a JS tool so no local check
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    const result = await probeAll(tmpDir);
    expect(result.rg).toBe(false);
  });

  it("global PATH takes priority — tsc found globally is not double-checked locally", async () => {
    // which succeeds for tsc
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const arg = (args as string[])[0];
        if (arg === "tsc") {
          (cb as (err: null, stdout: string, stderr: string) => void)(
            null,
            "/usr/local/bin/tsc",
            "",
          );
        } else {
          const err = new Error("not found") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          (cb as (err: Error) => void)(err);
        }
      }
      return undefined as never;
    });

    const result = await probeAll(tmpDir);
    expect(result.tsc).toBe(true);
  });

  it("returns false when no workspace given and tool not on global PATH", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (typeof cb === "function") {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (cb as (err: Error) => void)(err);
      }
      return undefined as never;
    });

    // No workspace passed — local check skipped even though tmpDir has a local tsc
    const result = await probeAll("");
    expect(result.tsc).toBe(false);
  });
});
