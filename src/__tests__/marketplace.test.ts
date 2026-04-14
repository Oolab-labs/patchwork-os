import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs (for bundled fallback)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runMarketplace } from "../commands/marketplace.js";

const mockedExecFileSync = vi.mocked(execFileSync) as Mock;
const mockedReadFileSync = vi.mocked(readFileSync) as Mock;

const SAMPLE_REGISTRY = JSON.stringify([
  {
    name: "tdd-loop",
    description: "Test-driven development automation loop",
    npmPackage: "claude-ide-bridge",
    type: "skill",
    version: "latest",
    author: "Oolab Labs",
    builtin: true,
  },
  {
    name: "custom-skill",
    description: "A custom community skill",
    npmPackage: "custom-skill-pkg",
    type: "skill",
    version: "1.0.0",
    author: "Community",
    builtin: false,
  },
]);

describe("runMarketplace", () => {
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

    // Default: fetch fails → fall back to bundled
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    mockedReadFileSync.mockReturnValue(SAMPLE_REGISTRY);
    mockedExecFileSync.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list falls back to bundled registry when fetch fails", async () => {
    await runMarketplace(["list"]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("tdd-loop");
    expect(out).toContain("custom-skill");
  });

  it("list uses fetched registry when fetch succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => JSON.parse(SAMPLE_REGISTRY),
    });
    await runMarketplace(["list"]);
    expect(stdoutOutput.join("\n")).toContain("tdd-loop");
  });

  it("search filters by name", async () => {
    await runMarketplace(["search", "custom"]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("custom-skill");
    expect(out).not.toContain("tdd-loop");
  });

  it("search filters by description", async () => {
    await runMarketplace(["search", "automation"]);
    const out = stdoutOutput.join("\n");
    expect(out).toContain("tdd-loop");
  });

  it("search with no matches prints message", async () => {
    await runMarketplace(["search", "nonexistentxyz"]);
    expect(stdoutOutput.join("\n")).toContain("No skills matching");
  });

  it("install calls npm for non-builtin skill", async () => {
    await runMarketplace(["install", "custom-skill"]);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "custom-skill-pkg"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    const out = stdoutOutput.join("\n");
    expect(out).toContain("--plugin");
  });

  it("install builtin skill skips npm and informs user", async () => {
    await runMarketplace(["install", "tdd-loop"]);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(stdoutOutput.join("\n")).toContain("builtin");
  });

  it("install unknown skill exits with error", async () => {
    await expect(runMarketplace(["install", "ghost"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(stderrOutput.join("")).toContain("Unknown skill");
  });

  it("unknown subcommand exits with error", async () => {
    await expect(runMarketplace(["badcmd"])).rejects.toThrow("process.exit(1)");
    expect(stderrOutput.join("")).toContain("Unknown marketplace command");
  });
});
