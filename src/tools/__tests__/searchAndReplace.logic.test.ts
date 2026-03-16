/**
 * Logic tests for searchAndReplace that run without a real `rg` binary.
 *
 * These tests mock `execSafe` (the rg subprocess call) to return a controlled
 * list of files, then exercise the pure-JS replacement logic that follows.
 * They run on all platforms including macOS/Claude Code where rg is a shell
 * function rather than a real binary.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock utils.js BEFORE importing the tool so execSafe is interceptable.
vi.mock("../utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../utils.js")>();
  return { ...original, execSafe: vi.fn() };
});

import { createSearchAndReplaceTool } from "../searchAndReplace.js";
// Import AFTER the mock is established.
import { execSafe } from "../utils.js";

const mockedExecSafe = execSafe as ReturnType<typeof vi.fn>;

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("searchAndReplace — core replacement logic (mock rg)", () => {
  let tmpDir: string;
  let alphaPath: string;
  let betaPath: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sar-logic-")),
    );
    alphaPath = path.join(tmpDir, "alpha.txt");
    betaPath = path.join(tmpDir, "beta.txt");
    fs.writeFileSync(alphaPath, "hello world\nhello again\n");
    fs.writeFileSync(betaPath, "goodbye world\n");

    // Default: rg reports only alpha.txt as matching
    mockedExecSafe.mockResolvedValue({ stdout: `${alphaPath}\n`, stderr: "" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("literal replace modifies matching content", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({ pattern: "hello", replacement: "hi" });
    const data = parse(result);

    expect(data.totalReplacements).toBe(2);
    expect(data.modified).toBe(1);
    const content = fs.readFileSync(alphaPath, "utf-8");
    expect(content).toContain("hi world");
    expect(content).not.toContain("hello");
  });

  it("dryRun: true reports changes but does not write", async () => {
    const original = fs.readFileSync(alphaPath, "utf-8");
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "hello",
      replacement: "hi",
      dryRun: true,
    });
    const data = parse(result);

    expect(data.dryRun).toBe(true);
    expect(data.totalReplacements).toBe(2);
    expect(fs.readFileSync(alphaPath, "utf-8")).toBe(original);
  });

  it("regex replace with capture group works", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "(hello) (world)",
      replacement: "$2 $1",
      isRegex: true,
    });
    const data = parse(result);

    expect(data.totalReplacements).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(alphaPath, "utf-8")).toContain("world hello");
  });

  it("no-match returns 0 files modified", async () => {
    mockedExecSafe.mockResolvedValue({ stdout: "", stderr: "" });
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "zzz_no_match",
      replacement: "x",
    });
    const data = parse(result);

    expect(data.matched).toBe(0);
    expect(data.modified).toBe(0);
  });

  it("empty pattern returns error", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({ pattern: "", replacement: "x" });
    expect((result as any).isError).toBe(true);
  });

  it("invalid regex returns error", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "[unclosed",
      replacement: "x",
      isRegex: true,
    });
    expect((result as any).isError).toBe(true);
  });

  it("rejects glob starting with '-' to prevent rg flag injection", async () => {
    // Regression: '--no-ignore-vcs' passed as glob would be interpreted as a
    // flag by rg, silently disabling VCS ignore rules.
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "hello",
      replacement: "hi",
      glob: "--no-ignore-vcs",
    });
    expect((result as any).isError).toBe(true);
    expect(parse(result).error).toMatch(/glob.*must not start with/i);
    // execSafe (rg) should not have been called
    expect(mockedExecSafe).not.toHaveBeenCalled();
  });

  it("rejects glob starting with '-' single dash form", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "hello",
      replacement: "hi",
      glob: "-e",
    });
    expect((result as any).isError).toBe(true);
    expect(parse(result).error).toMatch(/must not start with/i);
  });

  it("rejects pattern containing null byte (flag injection via rg -e arg)", async () => {
    // Regression: a null byte (\x00) in the pattern terminates the rg -e argument
    // at the OS level, causing rg to see an empty pattern and match every line.
    // The JS split(pattern) then has no matches, producing a misleading 0-replacement result.
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = parse(
      await tool.handler({ pattern: "import\x00bar", replacement: "x" }),
    );
    expect(result.error).toMatch(/null byte/i);
    expect(mockedExecSafe).not.toHaveBeenCalled();
  });

  it("replaces across multiple matched files", async () => {
    mockedExecSafe.mockResolvedValue({
      stdout: `${alphaPath}\n${betaPath}\n`,
      stderr: "",
    });
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "world",
      replacement: "earth",
    });
    const data = parse(result);

    expect(data.modified).toBe(2);
    expect(fs.readFileSync(alphaPath, "utf-8")).toContain("earth");
    expect(fs.readFileSync(betaPath, "utf-8")).toContain("earth");
  });
});
