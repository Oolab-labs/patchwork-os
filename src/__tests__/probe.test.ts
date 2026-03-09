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
