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
    expect(out).toContain("database");
    expect(out).toContain("slack");
    expect(out).toContain("playwright");
    expect(out).toContain("codebase-memory");
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

  it("--env overrides land in written config env block", async () => {
    await runInstall([
      "slack",
      "--env",
      "SLACK_BOT_TOKEN=xoxb-real",
      "--env",
      "SLACK_TEAM_ID=T12345",
    ]);

    const writeCalls = mockedWriteFileSync.mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(writeCalls[0]?.[1] as string);
    expect(written.mcpServers.slack.env.SLACK_BOT_TOKEN).toBe("xoxb-real");
    expect(written.mcpServers.slack.env.SLACK_TEAM_ID).toBe("T12345");
  });

  it("--env values with = in value are parsed correctly", async () => {
    await runInstall([
      "database",
      "--env",
      "DSN=postgresql://user:p@ss=word@localhost/db",
    ]);

    const writeCalls = mockedWriteFileSync.mock.calls;
    const written = JSON.parse(writeCalls[0]?.[1] as string);
    expect(written.mcpServers.database.env.DSN).toBe(
      "postgresql://user:p@ss=word@localhost/db",
    );
  });

  it("postInstallMessage is printed after install", async () => {
    await runInstall(["playwright"]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("npx playwright install chromium");
  });

  it("skipNpmInstall skips execFileSync but still writes config", async () => {
    await runInstall(["codebase-memory"]);

    // npm install should NOT have been called
    expect(mockedExecFileSync).not.toHaveBeenCalled();

    // config should still be written
    const writeCalls = mockedWriteFileSync.mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(writeCalls[0]?.[1] as string);
    expect(written.mcpServers["codebase-memory"]).toBeDefined();

    // postInstallMessage should be shown
    const out = stdoutOutput.join("\n");
    expect(out).toContain("curl -fsSL");
  });

  it("devtools entry has no requiredEnv", async () => {
    await runInstall(["devtools"]);

    const writeCalls = mockedWriteFileSync.mock.calls;
    const written = JSON.parse(writeCalls[0]?.[1] as string);
    // env block should be absent (Puppeteer auto-launches Chrome)
    expect(written.mcpServers.devtools.env).toBeUndefined();
  });

  it("requiredEnv note is suppressed when --env overrides provided", async () => {
    await runInstall([
      "slack",
      "--env",
      "SLACK_BOT_TOKEN=xoxb-real",
      "--env",
      "SLACK_TEAM_ID=T123",
    ]);
    const out = stdoutOutput.join("\n");
    // Should NOT print "export SLACK_BOT_TOKEN=..." since overrides were supplied
    expect(out).not.toContain("export SLACK_BOT_TOKEN");
  });

  describe("--target cli", () => {
    // CLAUDE_CONFIG_DIR overrides the home dir base for the CLI config path
    const testHomeDir = "/tmp/test-home";

    beforeEach(() => {
      process.env.CLAUDE_CONFIG_DIR = testHomeDir;
    });

    afterEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
    });

    it("writes to ~/.claude.json not Desktop config", async () => {
      await runInstall(["playwright", "--target", "cli"]);

      const writeCalls = mockedWriteFileSync.mock.calls;
      expect(writeCalls.length).toBeGreaterThan(0);
      // atomic write uses .tmp suffix; check any call targets the right base path
      const allPaths = writeCalls.map((c) => c[0] as string);
      const hasCli = allPaths.some((p) =>
        p.startsWith(`${testHomeDir}/.claude.json`),
      );
      expect(hasCli).toBe(true);
      expect(allPaths.every((p) => !p.includes("claude_desktop_config"))).toBe(
        true,
      );
    });

    it("prints CLI reload message not Desktop restart message", async () => {
      await runInstall(["playwright", "--target", "cli"]);
      const out = stdoutOutput.join("\n");
      expect(out).toContain("Run /mcp in Claude Code");
      expect(out).not.toContain("Restart Claude Desktop");
    });

    it("idempotency message says Claude Code CLI", async () => {
      const existingConfig = JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
        },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(existingConfig);

      await runInstall(["playwright", "--target", "cli"]);
      const out = stdoutOutput.join("\n");
      expect(out).toContain("Claude Code CLI");
    });

    it("--target desktop (explicit) writes to Desktop config", async () => {
      await runInstall(["playwright", "--target", "desktop"]);

      const writeCalls = mockedWriteFileSync.mock.calls;
      const writtenPath = writeCalls[0]?.[0] as string;
      expect(writtenPath).toContain("claude_desktop_config");
    });

    it("default (no --target) writes to Desktop config for backwards compat", async () => {
      await runInstall(["playwright"]);

      const writeCalls = mockedWriteFileSync.mock.calls;
      const writtenPath = writeCalls[0]?.[0] as string;
      expect(writtenPath).toContain("claude_desktop_config");
    });
  });
});
