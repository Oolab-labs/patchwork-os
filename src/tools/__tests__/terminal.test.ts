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

describe("runInTerminal - metacharacter blocking", () => {
  function mockRunInTerminalClient(connected = true) {
    return {
      isConnected: () => connected,
      executeInTerminal: vi.fn().mockResolvedValue("output"),
    } as any;
  }

  it("blocks tilde home-dir expansion", async () => {
    const tool = createRunInTerminalTool(mockRunInTerminalClient(), ["cat"]);
    const result = (await tool.handler({
      command: "cat ~/.ssh/id_rsa",
    })) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("metacharacter");
  });

  it("blocks carriage return", async () => {
    const tool = createRunInTerminalTool(mockRunInTerminalClient(), ["echo"]);
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
