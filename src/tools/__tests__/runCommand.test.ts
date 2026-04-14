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

    it("rejects --config=path (equals-sign form) for non-exempt commands", async () => {
      const tool = createRunCommandTool(tmpDir, config);
      await expect(
        tool.handler({ command: "echo", args: ["--config=/etc/evil"] }),
      ).rejects.toThrow("blocked");
    });

    it("allows --config for psql (exempt command)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "psql"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      // psql won't be installed in test env, so it will fail to execute
      // but it should NOT throw a validation error about --config being blocked
      const result = await tool.handler({
        command: "psql",
        args: ["--config=myservice"],
      });
      // If we got here without a "blocked" error, the exemption works.
      // The handler returns an error result (psql not found) rather than throwing.
      const data = parse(result);
      expect(data).toBeDefined();
    });

    it("allows --config for pg_dump (exempt command)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "pg_dump"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      const result = await tool.handler({
        command: "pg_dump",
        args: ["--config=myservice"],
      });
      const data = parse(result);
      expect(data).toBeDefined();
    });

    it("still blocks --prefix for psql (not in exemptions)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "psql"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "psql", args: ["--prefix=/evil"] }),
      ).rejects.toThrow("blocked");
    });

    it("still blocks --config for echo (not exempt)", async () => {
      const tool = createRunCommandTool(tmpDir, config);
      await expect(
        tool.handler({ command: "echo", args: ["--config=evil.js"] }),
      ).rejects.toThrow("blocked");
    });

    // -f and -r: per-command blocks (DANGEROUS_FLAGS_FOR_COMMAND)
    it("blocks make -f (arbitrary Makefile path)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "make"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "make", args: ["-f", "/tmp/evil.mk"] }),
      ).rejects.toThrow("blocked");
    });

    it("blocks make --file (long form of -f)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "make"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "make", args: ["--file=/tmp/evil.mk"] }),
      ).rejects.toThrow("blocked");
    });

    it("blocks node -r (pre-require arbitrary module)", async () => {
      const cfg: Config = { ...config, commandAllowlist: ["node"] };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({ command: "node", args: ["-r", "evil-module"] }),
      ).rejects.toThrow("blocked");
    });

    it("allows grep -r (recursive search — harmless for grep)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "grep"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      // grep -r will run (may or may not find matches) — should NOT throw "blocked"
      const result = await tool.handler({
        command: "grep",
        args: ["-r", "nonexistent-string-xyz", tmpDir],
      });
      const data = parse(result);
      // exit 1 means no matches — that is fine; what matters is no validation error
      expect([0, 1]).toContain(data.exitCode);
    });

    it("allows docker -f (compose file flag — harmless for docker)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "docker"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      // docker may not be installed; result is an error content block, not a throw
      const result = await tool.handler({
        command: "docker",
        args: ["-f", "docker-compose.yml", "ps"],
      });
      // If we reach here without a "blocked" throw, the fix works
      expect(result).toBeDefined();
    });

    it("allows sort -f (case-insensitive sort flag — harmless)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "sort"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      const result = await tool.handler({
        command: "sort",
        args: ["-f"],
      });
      const data = parse(result);
      expect(data).toBeDefined(); // no validation error thrown
    });

    it("blocks curl -o (output to file — path write risk)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "curl"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({
          command: "curl",
          args: ["-o", "/tmp/evil", "http://example.com"],
        }),
      ).rejects.toThrow("blocked");
    });

    it("blocks curl --output (long form of -o)", async () => {
      const cfg: Config = {
        ...config,
        commandAllowlist: [...config.commandAllowlist, "curl"],
      };
      const tool = createRunCommandTool(tmpDir, cfg);
      await expect(
        tool.handler({
          command: "curl",
          args: ["--output=/tmp/evil", "http://example.com"],
        }),
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

  describe("progress notifications (streaming)", () => {
    it("emits one progress notification per stdout line when progress provided", async () => {
      // Write a shell script that prints 3 lines
      const script = path.join(tmpDir, "multiline.sh");
      fs.writeFileSync(script, "printf 'line1\\nline2\\nline3\\n'", "utf-8");
      fs.chmodSync(script, 0o755);

      const cfg: Config = { ...config, commandAllowlist: ["printf"] };
      const tool = createRunCommandTool(tmpDir, cfg);

      const calls: Array<{ value: number; total: number; message?: string }> =
        [];
      const progressFn = (value: number, total: number, message?: string) => {
        calls.push({ value, total, message });
      };

      const result = await (
        tool.handler as (
          args: Record<string, unknown>,
          signal?: AbortSignal,
          progress?: typeof progressFn,
        ) => Promise<typeof result>
      )(
        { command: "printf", args: ["line1\\nline2\\nline3\\n"] },
        undefined,
        progressFn,
      );

      const data = parse(result);
      expect(data.exitCode).toBe(0);
      // Each progress call carries a line as message
      const messages = calls.map((c) => c.message);
      expect(messages).toContain("line1");
      expect(messages).toContain("line2");
      expect(messages).toContain("line3");
      // Values increment per line
      const values = calls.map((c) => c.value);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    });

    it("returns correct stdout in result even when streaming", async () => {
      const cfg: Config = { ...config, commandAllowlist: ["echo"] };
      const tool = createRunCommandTool(tmpDir, cfg);

      const progressFn = () => {};
      const result = await (
        tool.handler as (
          args: Record<string, unknown>,
          signal?: AbortSignal,
          progress?: typeof progressFn,
        ) => Promise<typeof result>
      )({ command: "echo", args: ["streaming-test"] }, undefined, progressFn);

      const data = parse(result);
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toContain("streaming-test");
    });

    it("falls back to heartbeat when no progress fn provided", async () => {
      const tool = createRunCommandTool(tmpDir, config);
      // No progress fn — should use withHeartbeat path, still work normally
      const result = await tool.handler({
        command: "echo",
        args: ["no-progress"],
      });
      const data = parse(result);
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toContain("no-progress");
    });
  });
});
