import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock child_process before importing module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { runInstall } from "../commands/install.js";

const mockedExecFileSync = vi.mocked(execFileSync) as Mock;
const mockedExistsSync = vi.mocked(existsSync) as Mock;
const mockedReadFileSync = vi.mocked(readFileSync) as Mock;
const mockedWriteFileSync = vi.mocked(writeFileSync) as Mock;
const mockedRenameSync = vi.mocked(renameSync) as Mock;

describe("runInstall", () => {
  let stdoutOutput: string[];
  let stderrOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    stderrOutput = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutOutput.push(args.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderrOutput.push(String(s));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    mockedExecFileSync.mockReturnValue(Buffer.from(""));
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue("{}");
    mockedWriteFileSync.mockReturnValue(undefined);
    mockedRenameSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--list prints all companions", async () => {
    await runInstall(["--list"]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("memory");
    expect(out).toContain("superpowers");
    expect(out).toContain("devtools");
  });

  it("no args prints companion list", async () => {
    await runInstall([]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("memory");
  });

  it("install known companion writes mcpServers entry", async () => {
    // Config file doesn't exist initially
    mockedExistsSync.mockReturnValue(false);

    await runInstall(["memory"]);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@modelcontextprotocol/server-memory"],
      expect.objectContaining({ stdio: "inherit" }),
    );

    // writeFileSync called with JSON containing mcpServers.memory
    const writeCalls = mockedWriteFileSync.mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const writtenContent = writeCalls[0]?.[1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.memory).toBeDefined();
    expect(parsed.mcpServers.memory.command).toBe("npx");

    const output = stdoutOutput.join("\n");
    expect(output).toContain("Restart Claude Desktop");
  });

  it("unknown companion exits with error", async () => {
    await expect(runInstall(["nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(stderrOutput.join("")).toContain("Unknown companion");
  });

  it("idempotent if companion already present", async () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        memory: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
      },
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(existingConfig);

    await runInstall(["memory"]);

    // Should not write again
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    const output = stdoutOutput.join("\n");
    expect(output).toContain("already configured");
  });
});
