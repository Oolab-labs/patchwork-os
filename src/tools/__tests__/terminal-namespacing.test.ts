/**
 * Tests for terminal tool session namespacing (terminalPrefix).
 * These tests catch two bugs:
 *  - Bug 6: Index-based lookup bypasses session prefix — wrong session's terminal returned
 *  - Bug 7: Unnamed terminal gets no prefix, becomes invisible to the creating session
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCreateTerminalTool,
  createDisposeTerminalTool,
  createGetTerminalOutputTool,
  createRunInTerminalTool,
  createSendTerminalCommandTool,
  createWaitForTerminalOutputTool,
} from "../terminal.js";

function mockExtensionClient(connected = true) {
  return {
    isConnected: () => connected,
    createTerminal: vi
      .fn()
      .mockResolvedValue({ name: "s1234567-build", index: 0 }),
    sendTerminalCommand: vi.fn().mockResolvedValue({ success: true }),
    listTerminals: vi.fn().mockResolvedValue({
      terminals: [
        { name: "s1234567-build", index: 0 },
        { name: "s9abcdef-test", index: 1 },
      ],
    }),
    getTerminalOutput: vi.fn().mockResolvedValue({ lines: ["output"] }),
    waitForTerminalOutput: vi
      .fn()
      .mockResolvedValue({ matched: true, matchedLine: "ready" }),
    executeInTerminal: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    disposeTerminal: vi.fn().mockResolvedValue({ success: true }),
  } as any;
}

function parseResult(result: any): string {
  return result.content?.at(0)?.text ?? "";
}

const PREFIX = "s1234567-";
const WORKSPACE = "/tmp/workspace";
const ALLOWLIST = ["npm", "vitest"];

// ── Bug 7: Unnamed terminal gets no prefix ────────────────────────────────────

describe("createTerminal — unnamed terminal with prefix (Bug 7)", () => {
  it("creates a prefixed name when no name argument is provided", async () => {
    const client = mockExtensionClient();
    const tool = createCreateTerminalTool(WORKSPACE, client, PREFIX);

    await tool.handler({});

    // Extension should have been called with a name that starts with the prefix
    const calledName = client.createTerminal.mock.calls[0][0];
    expect(typeof calledName).toBe("string");
    expect(calledName).toMatch(new RegExp(`^${PREFIX}`));
  });

  it("creates a prefixed name even when name is explicitly undefined", async () => {
    const client = mockExtensionClient();
    const tool = createCreateTerminalTool(WORKSPACE, client, PREFIX);

    await tool.handler({ name: undefined });

    const calledName = client.createTerminal.mock.calls[0][0];
    expect(typeof calledName).toBe("string");
    expect(calledName).toMatch(new RegExp(`^${PREFIX}`));
  });

  it("does NOT generate a prefix name when prefix is empty (single-session compat)", async () => {
    const client = mockExtensionClient();
    client.createTerminal = vi
      .fn()
      .mockResolvedValue({ name: "terminal", index: 0 });
    const tool = createCreateTerminalTool(WORKSPACE, client, "");

    await tool.handler({});

    const calledName = client.createTerminal.mock.calls[0][0];
    // No prefix: name remains undefined (extension assigns its own default)
    expect(calledName).toBeUndefined();
  });
});

// ── Bug 6: Index-based lookup bypasses session prefix ─────────────────────────

describe("getTerminalOutput — index-only lookup with prefix (Bug 6)", () => {
  it("returns an error when index is used without name in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createGetTerminalOutputTool(client, PREFIX);

    const result = (await tool.handler({ index: 0 })) as any;

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body).toMatch(/name/i); // Error should mention using name instead
  });

  it("succeeds with name-based lookup (prefix applied) in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createGetTerminalOutputTool(client, PREFIX);

    const result = (await tool.handler({ name: "build" })) as any;

    expect(result.isError).toBeUndefined();
    // Extension should have been called with the prefixed name
    expect(client.getTerminalOutput).toHaveBeenCalledWith(
      `${PREFIX}build`,
      undefined,
      undefined,
    );
  });
});

describe("sendTerminalCommand — index-only lookup with prefix (Bug 6)", () => {
  it("returns an error when index is used without name in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createSendTerminalCommandTool(client, ALLOWLIST, PREFIX);

    const result = (await tool.handler({ text: "npm test", index: 0 })) as any;

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body).toMatch(/name/i);
  });
});

describe("disposeTerminal — index-only lookup with prefix (Bug 6)", () => {
  it("returns an error when index is used without name in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createDisposeTerminalTool(client, PREFIX);

    const result = (await tool.handler({ index: 0 })) as any;

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body).toMatch(/name/i);
  });
});

describe("runInTerminal — index-only lookup with prefix (Bug 6)", () => {
  it("returns an error when index is used without name in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createRunInTerminalTool("/tmp/workspace", client, ALLOWLIST, PREFIX);

    const result = (await tool.handler({
      command: "npm test",
      index: 0,
    })) as any;

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body).toMatch(/name/i);
  });
});

describe("waitForTerminalOutput — index-only lookup with prefix (Bug 6)", () => {
  it("returns an error when index is used without name in multi-session mode", async () => {
    const client = mockExtensionClient();
    const tool = createWaitForTerminalOutputTool(client, PREFIX);

    const result = (await tool.handler({ pattern: "ready", index: 0 })) as any;

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body).toMatch(/name/i);
  });
});
