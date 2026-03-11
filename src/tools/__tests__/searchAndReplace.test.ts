import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSearchAndReplaceTool } from "../searchAndReplace.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

// The `rg` command is only a shell function here (wrapping the Claude binary).
// Node's execFile cannot invoke shell functions, so we install a tiny shim
// script into a temp bin directory and prepend it to PATH for each test.
function installRgShim(): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-shim-bin-"));
  // Find the Claude binary that acts as rg
  const claudeBinary =
    "/Users/wesh/.windsurf/extensions/anthropic.claude-code-2.1.72-darwin-arm64/resources/native-binary/claude";
  const rgScript = path.join(binDir, "rg");
  // The shim sets ARGV0=rg so the Claude binary behaves as ripgrep
  fs.writeFileSync(rgScript, `#!/bin/sh\nexec -a rg "${claudeBinary}" "$@"\n`);
  fs.chmodSync(rgScript, 0o755);
  return binDir;
}

describe("searchAndReplace tool", () => {
  let tmpDir: string;
  let shimBinDir: string;
  let originalPath: string;

  beforeEach(() => {
    // Use realpathSync to resolve macOS /var -> /private/var symlink so the
    // workspace path matches what rg returns (absolute real paths).
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sar-test-")),
    );
    fs.writeFileSync(
      path.join(tmpDir, "alpha.txt"),
      "hello world\nhello again\n",
    );
    fs.writeFileSync(path.join(tmpDir, "beta.txt"), "goodbye world\n");

    // Install the rg shim and prepend its bin dir to PATH
    shimBinDir = installRgShim();
    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${shimBinDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(shimBinDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("literal replace modifies matching content in files", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({ pattern: "hello", replacement: "hi" });
    const data = parse(result);

    expect(data.totalReplacements).toBeGreaterThanOrEqual(2);
    const content = fs.readFileSync(path.join(tmpDir, "alpha.txt"), "utf-8");
    expect(content).toContain("hi world");
    expect(content).not.toContain("hello");
  });

  it("dryRun: true does not modify files", async () => {
    const original = fs.readFileSync(path.join(tmpDir, "alpha.txt"), "utf-8");
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "hello",
      replacement: "hi",
      dryRun: true,
    });
    const data = parse(result);

    expect(data.dryRun).toBe(true);
    expect(data.totalReplacements).toBeGreaterThanOrEqual(1);
    // File should be unchanged
    const afterContent = fs.readFileSync(
      path.join(tmpDir, "alpha.txt"),
      "utf-8",
    );
    expect(afterContent).toBe(original);
  });

  it("regex replace with a capture group works", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "(hello) (world)",
      replacement: "$2 $1",
      isRegex: true,
    });
    const data = parse(result);

    expect(data.totalReplacements).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(path.join(tmpDir, "alpha.txt"), "utf-8");
    expect(content).toContain("world hello");
  });

  it("pattern that matches nothing returns 0 files modified", async () => {
    const tool = createSearchAndReplaceTool(tmpDir);
    const result = await tool.handler({
      pattern: "zzz_no_match_zzz",
      replacement: "x",
    });
    const data = parse(result);

    expect(data.matched).toBe(0);
    expect(data.modified).toBe(0);
  });
});
