import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", 0);
    return true;
  });
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

async function emitSuccessAndAwait(promise: Promise<unknown>): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  mockChild.stdout.emit(
    "data",
    `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
  );
  mockChild.emit("close", 0);
  await promise;
}

describe("SubprocessDriver argv injection guards", () => {
  let driver: SubprocessDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new SubprocessDriver("claude", "ant", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws synchronously when prompt starts with '-' (spawn never called)", async () => {
    await expect(driver.run(makeInput({ prompt: "-rf /" }))).rejects.toThrow(
      /prompt cannot start with '-'/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("drops --model when input.model starts with '-'", async () => {
    const p = driver.run(makeInput({ model: "--evil" }));
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--evil");
  });

  it("still passes --model when input.model is a normal model id", async () => {
    const p = driver.run(makeInput({ model: "claude-sonnet-4-6" }));
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("drops --system-prompt when systemPrompt starts with '-'", async () => {
    const p = driver.run(makeInput({ systemPrompt: "--malicious-flag" }));
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("--malicious-flag");
  });

  it("drops --effort when providerOptions.effort starts with '-'", async () => {
    const p = driver.run(makeInput({ providerOptions: { effort: "-x" } }));
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("-x");
  });

  it("drops --fallback-model when providerOptions.fallbackModel starts with '-'", async () => {
    const p = driver.run(
      makeInput({ providerOptions: { fallbackModel: "-rm" } }),
    );
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--fallback-model");
    expect(args).not.toContain("-rm");
  });

  it("drops --add-dir entries when contextFile starts with '-' (existing line-75 guard, regression coverage)", async () => {
    const p = driver.run(
      makeInput({ contextFiles: ["--evil-flag", "/safe/path"] }),
    );
    await emitSuccessAndAwait(p);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--evil-flag");
    const addDirIdx = args.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThan(-1);
    expect(args[addDirIdx + 1]).toBe("/safe/path");
  });
});
