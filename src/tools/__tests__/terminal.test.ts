import { describe, it, expect, vi } from "vitest";
import { createCreateTerminalTool, createSendTerminalCommandTool } from "../terminal.js";

function mockExtensionClient(connected = true) {
  return {
    isConnected: () => connected,
    createTerminal: vi.fn().mockResolvedValue({ name: "test", index: 0 }),
    sendTerminalCommand: vi.fn().mockResolvedValue({ success: true }),
    listTerminals: vi.fn().mockResolvedValue([]),
    getTerminalOutput: vi.fn().mockResolvedValue(""),
  } as any;
}

function parseResult(result: any) {
  return JSON.parse(result.content?.at(0)?.text ?? "{}");
}

describe("createTerminal - dangerous env vars", () => {
  const workspace = "/tmp/test-workspace";

  it("blocks PATH in env", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { PATH: "/evil" } }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("blocked");
  });

  it("blocks LD_PRELOAD (case-insensitive)", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { ld_preload: "/evil.so" } }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("blocked");
  });

  it("blocks NODE_OPTIONS", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { NODE_OPTIONS: "--inspect" } }) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks PYTHONPATH", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { PYTHONPATH: "/evil" } }) as any;
    expect(result.isError).toBe(true);
  });

  it("blocks BASH_ENV", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { BASH_ENV: "/evil.sh" } }) as any;
    expect(result.isError).toBe(true);
  });

  it("allows safe env vars", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { MY_VAR: "hello", DEBUG: "true" } }) as any;
    expect(result.isError).toBeUndefined();
  });

  it("rejects env with more than 50 entries", async () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 51; i++) env[`VAR_${i}`] = "v";
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("50");
  });

  it("rejects non-object env", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: "not-an-object" }) as any;
    expect(result.isError).toBe(true);
  });

  it("rejects non-string env values", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient());
    const result = await tool.handler({ env: { FOO: 123 } }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("string");
  });

  it("returns error when extension not connected", async () => {
    const tool = createCreateTerminalTool(workspace, mockExtensionClient(false));
    const result = await tool.handler({}) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not connected");
  });
});

describe("sendTerminalCommand - allowlist", () => {
  it("blocks commands not in allowlist", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["npm", "node"]);
    const result = await tool.handler({ text: "rm -rf /", name: "test" }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not in the allowlist");
  });

  it("allows commands in the allowlist", async () => {
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ["npm", "node"]);
    const result = await tool.handler({ text: "npm install", name: "test" }) as any;
    expect(result.isError).toBeUndefined();
    expect(client.sendTerminalCommand).toHaveBeenCalledWith("npm install", "test", undefined, true);
  });

  it("extracts first word correctly with leading spaces", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["npm"]);
    const result = await tool.handler({ text: "  npm install", name: "test" }) as any;
    expect(result.isError).toBeUndefined();
  });

  it("blocks when allowlist is empty", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), []);
    const result = await tool.handler({ text: "anything", name: "test" }) as any;
    expect(result.isError).toBe(true);
  });

  it("requires name or index", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(), ["echo"]);
    const result = await tool.handler({ text: "echo hi" }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("name");
  });

  it("returns error when extension not connected", async () => {
    const tool = createSendTerminalCommandTool(mockExtensionClient(false), ["npm"]);
    const result = await tool.handler({ text: "npm install", name: "test" }) as any;
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toContain("not connected");
  });
});
