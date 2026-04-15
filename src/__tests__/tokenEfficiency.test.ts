import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tokenEfficiencyBenchmark,
  tokenEfficiencyStatus,
} from "../commands/tokenEfficiency.js";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("../config.js", () => ({
  loadConfigFile: vi.fn(),
  parseConfig: vi.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as config from "../config.js";

// ── tokenEfficiencyStatus ─────────────────────────────────────────────────────

describe("tokenEfficiencyStatus", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(config.loadConfigFile).mockReturnValue({
      lspVerbosity: "minimal",
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("prints config section with lspVerbosity from config", async () => {
    // No lock files — bridge not running
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    await tokenEfficiencyStatus();

    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Token Efficiency Status");
    expect(output).toContain("minimal");
  });

  it("prints 'Bridge not running' when no lock files found", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    await tokenEfficiencyStatus();

    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Bridge not running");
  });

  it("gracefully handles missing lock dir (readdirSync throws)", async () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    // Should not throw
    await expect(tokenEfficiencyStatus()).resolves.toBeUndefined();

    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Bridge not running");
  });

  it("prints 'could not read' when lock file parse fails", async () => {
    const mockDirent = "12345.lock" as unknown as import("node:fs").Dirent;
    vi.mocked(fs.readdirSync).mockReturnValue([mockDirent]);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now(),
    } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EPERM");
    });

    await tokenEfficiencyStatus();

    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Could not read bridge lock file");
  });

  it("prints 'missing authToken' when lock file has no token", async () => {
    const mockDirent = "12345.lock" as unknown as import("node:fs").Dirent;
    vi.mocked(fs.readdirSync).mockReturnValue([mockDirent]);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now(),
    } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 123 }));

    await tokenEfficiencyStatus();

    const output = consoleSpy.mock.calls.flat().join("\n");
    expect(output).toContain("missing authToken");
  });
});

// ── tokenEfficiencyBenchmark ──────────────────────────────────────────────────

describe("tokenEfficiencyBenchmark", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns node with benchmark script and forwards args", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const mockChild = {
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === "close") cb(0);
        return mockChild;
      }),
    };
    vi.mocked(childProcess.spawn).mockReturnValue(
      mockChild as unknown as ReturnType<typeof childProcess.spawn>,
    );

    await tokenEfficiencyBenchmark(["--iterations", "10", "--json"]);

    expect(childProcess.spawn).toHaveBeenCalledOnce();
    const [cmd, spawnArgs] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(cmd).toBe("node");
    expect(spawnArgs).toContain("--iterations");
    expect(spawnArgs).toContain("10");
    expect(spawnArgs).toContain("--json");
    expect(spawnArgs[0]).toContain("benchmark.mjs");
  });

  it("exits with non-zero code when benchmark exits non-zero", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const mockChild = {
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === "close") cb(1);
        return mockChild;
      }),
    };
    vi.mocked(childProcess.spawn).mockReturnValue(
      mockChild as unknown as ReturnType<typeof childProcess.spawn>,
    );

    const originalExitCode = process.exitCode;
    try {
      await tokenEfficiencyBenchmark([]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("writes to stderr and exits when benchmark script not found", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Make exit throw to stop execution (process.exit is not-never in test context)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as () => never);

    await expect(tokenEfficiencyBenchmark([])).rejects.toThrow(
      "process.exit called",
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("benchmark script not found"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
