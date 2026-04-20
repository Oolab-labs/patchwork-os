import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSubprocessDriver } from "../gemini/index.js";

// Mock spawn to simulate Gemini stream-json output
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const log = vi.fn();

function makeChild(stdoutLines: string[], exitCode = 0) {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: () => void;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => child.emit("close", 1);

  vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);

  // Emit stdout lines on next tick
  setTimeout(() => {
    for (const line of stdoutLines) {
      stdout.emit("data", `${line}\n`);
    }
    child.emit("close", exitCode);
  }, 0);

  return child;
}

beforeEach(() => {
  log.mockReset();
  vi.mocked(spawn).mockReset();
});

const INIT = JSON.stringify({
  type: "init",
  session_id: "abc",
  model: "gemini-2.5-flash",
});
const ASSISTANT = (text: string) =>
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: text,
    delta: true,
  });
const RESULT_OK = JSON.stringify({
  type: "result",
  status: "success",
  stats: {},
});

describe("GeminiSubprocessDriver", () => {
  it("parses assistant messages and returns concatenated text", async () => {
    makeChild([INIT, ASSISTANT("Hello"), ASSISTANT(", world"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const chunks: string[] = [];
    const result = await driver.run({
      prompt: "say hello",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      onChunk: (c) => chunks.push(c),
    });
    expect(result.text).toBe("Hello, world");
    expect(chunks).toEqual(["Hello", ", world"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes -m flag when model specified", async () => {
    makeChild([INIT, ASSISTANT("ok"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      model: "gemini-2.5-pro",
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).toContain("-m");
    expect(args).toContain("gemini-2.5-pro");
  });

  it("uses yolo approval-mode by default", async () => {
    makeChild([INIT, ASSISTANT("ok"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).toContain("--approval-mode");
    expect(args).toContain("yolo");
  });

  it("skips non-JSON lines without crashing", async () => {
    makeChild([
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      INIT,
      ASSISTANT("hi"),
      RESULT_OK,
    ]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.text).toBe("hi");
  });

  it("returns exitCode 1 on result status error", async () => {
    const RESULT_ERR = JSON.stringify({
      type: "result",
      status: "error",
      stats: {},
    });
    makeChild([INIT, ASSISTANT("oops"), RESULT_ERR], 1);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.exitCode).toBe(1);
  });

  it("returns wasAborted on AbortError", async () => {
    const ac = new AbortController();
    const stdout = new EventEmitter() as EventEmitter & {
      setEncoding: () => void;
    };
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as EventEmitter & {
      setEncoding: () => void;
    };
    stderr.setEncoding = () => {};
    const child = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      stderr: typeof stderr;
      kill: () => void;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);

    setTimeout(() => {
      ac.abort();
      const err = Object.assign(new Error("aborted"), { name: "AbortError" });
      child.emit("error", err);
    }, 0);

    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: ac.signal,
    });
    expect(result.wasAborted).toBe(true);
  });
});
