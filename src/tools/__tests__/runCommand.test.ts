import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config.js";
import { createRunCommandTool } from "../runCommand.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("runCommand", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runcmd-test-"));
    config = {
      workspace: tmpDir,
      workspaceFolders: [tmpDir],
      ideName: "Test",
      editorCommand: null,
      port: null,
      verbose: false,
      jsonl: false,
      linters: [],
      commandAllowlist: ["echo", "ls", "sleep", "cat"],
      commandTimeout: 5000,
      maxResultSize: 512,
      vscodeCommandAllowlist: [],
      activeWorkspaceFolder: tmpDir,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects command with / in it", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    await expect(tool.handler({ command: "/bin/echo" })).rejects.toThrow(
      "must be a simple basename",
    );
  });

  it("rejects command with .. in it", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    await expect(tool.handler({ command: "..echo" })).rejects.toThrow(
      "must be a simple basename",
    );
  });

  it("rejects command not in allowlist", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    await expect(tool.handler({ command: "curl" })).rejects.toThrow(
      "not in the allowlist",
    );
  });

  it("runs echo and captures output", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    const result = await tool.handler({
      command: "echo",
      args: ["hello test"],
    });
    const data = parse(result);

    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain("hello test");
  });

  it("returns non-zero exit code without throwing", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    // cat a non-existent file returns exit code 1
    const result = await tool.handler({
      command: "cat",
      args: [path.join(tmpDir, "nonexistent-file-12345")],
    });
    const data = parse(result);

    expect(data.exitCode).not.toBe(0);
  });

  it("handles timeout", async () => {
    const shortConfig: Config = { ...config, commandTimeout: 1000 };
    const tool = createRunCommandTool(tmpDir, shortConfig);
    const result = await tool.handler({
      command: "sleep",
      args: ["10"],
      timeout: 1000,
    });
    const data = parse(result);

    expect(data.timedOut).toBe(true);
    expect(data.exitCode).not.toBe(0);
  }, 10000);

  it("passes shell metacharacters as literal args without injection", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    // These should be passed as literal args, not interpreted by a shell
    const result = await tool.handler({
      command: "echo",
      args: ["hello; rm -rf /", "$(evil)", "`evil`", "> /etc/passwd"],
    });
    const data = parse(result);
    // Command must succeed (no shell interpretation) and print the args literally
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain("hello; rm -rf /");
    expect(data.stdout).toContain("$(evil)");
  });

  it("rejects args array with non-string elements", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    await expect(
      tool.handler({ command: "echo", args: [{ nested: "object" }] }),
    ).rejects.toThrow();
  });

  it("rejects cwd outside workspace", async () => {
    const tool = createRunCommandTool(tmpDir, config);
    await expect(
      tool.handler({ command: "echo", args: ["1"], cwd: "/tmp" }),
    ).rejects.toThrow("escapes workspace");
  });

  describe("case-insensitive allowlist comparison", () => {
    it("accepts lowercase command when allowlist has mixed-case entry", async () => {
      const mixedCaseConfig: Config = {
        ...config,
        commandAllowlist: ["Git", "npm", "Echo"],
      };
      const tool = createRunCommandTool(tmpDir, mixedCaseConfig);
      // "echo" (lowercase) should match "Echo" in allowlist
      const result = await tool.handler({
        command: "echo",
        args: ["case-test"],
      });
      const data = parse(result);
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toContain("case-test");
    });

    it("accepts uppercase command when allowlist has lowercase entry", async () => {
      const tool = createRunCommandTool(tmpDir, config);
      // "ECHO" (uppercase) should match "echo" in allowlist
      // The command gets lowercased to "echo" which should match
      const result = await tool.handler({
        command: "ECHO",
        args: ["upper-test"],
      });
      const data = parse(result);
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toContain("upper-test");
    });

    it("accepts uppercase command when allowlist has mixed-case entry", async () => {
      const mixedCaseConfig: Config = {
        ...config,
        commandAllowlist: ["Git", "Npm", "Echo"],
      };
      const tool = createRunCommandTool(tmpDir, mixedCaseConfig);
      // "ECHO" (uppercase) should match "Echo" in allowlist
      const result = await tool.handler({
        command: "ECHO",
        args: ["mixed-test"],
      });
      const data = parse(result);
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toContain("mixed-test");
    });
  });

  describe("dangerous flag blocklist", () => {
    it("rejects --eval (bare) for interpreter commands", async () => {
      const cfg: Config = { ...config, commandAllowlist: ["node"] };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "node", args: ["--eval", "process.exit(0)"] }),
      ).rejects.toThrow("blocked");
    });

    it("rejects --eval=code (equals-sign form) for interpreter commands", async () => {
      const cfg: Config = { ...config, commandAllowlist: ["node"] };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "node", args: ["--eval=process.exit(0)"] }),
      ).rejects.toThrow("blocked");
    });

    it("rejects --config=path (equals-sign form) for all commands", async () => {
      const tool = createRunCommandTool(tmpDir, config);
      await expect(
        tool.handler({ command: "echo", args: ["--config=/etc/evil"] }),
      ).rejects.toThrow("blocked");
    });
  });

  it("runs command in a subdirectory cwd", async () => {
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "marker.txt"), "found");

    const tool = createRunCommandTool(tmpDir, config);
    const result = await tool.handler({
      command: "ls",
      args: [],
      cwd: "subdir",
    });
    const data = parse(result);

    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain("marker.txt");
  });
});
