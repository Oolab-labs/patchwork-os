import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
}

let mockChild: MockChild;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      mockChild = new MockChild();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      (mockChild.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
      (mockChild.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
      return mockChild;
    }),
  };
});

import { spawn } from "node:child_process";
import type { ProviderTaskInput } from "../../types.js";
import { SubprocessDriver } from "../subprocess.js";

const spawnMock = vi.mocked(spawn);

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: "/tmp/test",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function finishRun(p: Promise<unknown>): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  mockChild.stdout.emit(
    "data",
    `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
  );
  mockChild.emit("close", 0);
  await p;
}

describe("SubprocessDriver mcpAccess opt-in", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("does NOT pass --mcp-config by default (mcpAccess unset)", async () => {
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), () => ({
      url: "http://127.0.0.1:3101/mcp",
      authToken: "tkn",
    }));
    await finishRun(driver.run(makeInput()));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mcp-config");
  });

  it("does NOT pass --mcp-config when mcpAccess: false", async () => {
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), () => ({
      url: "http://127.0.0.1:3101/mcp",
      authToken: "tkn",
    }));
    await finishRun(
      driver.run(makeInput({ providerOptions: { mcpAccess: false } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mcp-config");
  });

  it("writes a temp --mcp-config file with the patchwork stdio shim when mcpAccess: true", async () => {
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), () => ({
      url: "http://127.0.0.1:3101/mcp",
      authToken: "tkn-abc",
    }));
    await finishRun(
      driver.run(makeInput({ providerOptions: { mcpAccess: true } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    const idx = args.indexOf("--mcp-config");
    expect(idx).toBeGreaterThan(-1);
    const cfgPath = args[idx + 1]!;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      mcpServers: Record<
        string,
        { type: string; command: string; args: string[] }
      >;
    };
    // Stdio shim — auto-discovers the bridge from ~/.claude/ide/*.lock at
    // runtime, so url/authToken from bridgeMcp() aren't echoed into the file.
    expect(cfg.mcpServers.patchwork).toEqual({
      type: "stdio",
      command: "claude-ide-bridge",
      args: ["shim"],
    });
  });

  it("logs a warning and skips --mcp-config when mcpAccess: true but bridge endpoint unavailable", async () => {
    const log = vi.fn();
    const driver = new SubprocessDriver("claude", "ant", log, () => undefined);
    await finishRun(
      driver.run(makeInput({ providerOptions: { mcpAccess: true } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mcp-config");
    expect(
      log.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes(
            "mcpAccess requested but bridge MCP endpoint unavailable",
          ),
      ),
    ).toBe(true);
  });

  it("logs a warning when mcpAccess: true but no bridgeMcp accessor wired", async () => {
    const log = vi.fn();
    const driver = new SubprocessDriver("claude", "ant", log);
    await finishRun(
      driver.run(makeInput({ providerOptions: { mcpAccess: true } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mcp-config");
    expect(
      log.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes(
            "mcpAccess requested but bridge MCP endpoint unavailable",
          ),
      ),
    ).toBe(true);
  });
});
