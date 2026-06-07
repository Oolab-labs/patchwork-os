import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSubprocessDriver } from "../gemini/index.js";

// Mock spawn to simulate Gemini stream-json output
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

// Mock node:os so we can redirect homedir() to a temp directory for
// settings.json restoration tests (LOW #9).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
    stdin: null;
    stdio: unknown[];
    kill: () => void;
    unref: () => void;
    killed: boolean;
    connected: boolean;
    pid: number;
    exitCode: number | null;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = null;
  child.stdio = [null, stdout, stderr];
  child.killed = false;
  child.connected = false;
  child.pid = 12345;
  child.exitCode = null;
  child.kill = () => child.emit("close", 1);
  child.unref = () => {};

  vi.mocked(spawn).mockReturnValueOnce(
    child as unknown as ReturnType<typeof spawn>,
  );

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

  it("respects custom approvalMode from providerOptions", async () => {
    makeChild([INIT, ASSISTANT("ok"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      providerOptions: { approvalMode: "auto_edit" },
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).toContain("auto_edit");
  });

  it("appends --include-directories for contextFiles", async () => {
    makeChild([INIT, ASSISTANT("ok"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    await driver.run({
      prompt: "hi",
      workspace: "/workspace",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      contextFiles: ["src/foo.ts", "/abs/bar.ts", "-bad"],
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    const idx = args.indexOf("--include-directories");
    expect(idx).toBeGreaterThan(-1);
    // absolute path passed through
    expect(args).toContain("/abs/bar.ts");
    // leading-dash entry skipped
    expect(args).not.toContain("-bad");
  });

  it("caps stderr at OUTPUT_CAP", async () => {
    const bigStderr = "x".repeat(60 * 1024);
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
      stdin: null;
      stdio: unknown[];
      kill: () => void;
      unref: () => void;
      killed: boolean;
      connected: boolean;
      pid: number;
      exitCode: number | null;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.stdio = [null, stdout, stderr];
    child.killed = false;
    child.connected = false;
    child.pid = 12345;
    child.exitCode = null;
    child.kill = () => {};
    child.unref = () => {};
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );
    setTimeout(() => {
      stderr.emit("data", bigStderr);
      stdout.emit("data", `${RESULT_OK}\n`);
      child.emit("close", 1);
    }, 0);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    // stderrTail is sliced to last 2048 chars
    expect(result.stderrTail?.length).toBeLessThanOrEqual(2048);
  });

  it("returns startupTimedOut when startup timeout fires before first chunk", async () => {
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
      stdin: null;
      stdio: unknown[];
      kill: () => void;
      unref: () => void;
      killed: boolean;
      connected: boolean;
      pid: number;
      exitCode: number | null;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.stdio = [null, stdout, stderr];
    child.killed = false;
    child.connected = false;
    child.pid = 12345;
    child.exitCode = null;
    child.kill = () => child.emit("close", 1);
    child.unref = () => {};
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );
    // Never emit any output — startup timeout will fire
    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      startupTimeoutMs: 10,
    });
    expect(result.wasAborted).toBe(true);
    expect(result.startupTimedOut).toBe(true);
  });

  it("runOutcome wraps run result as done outcome", async () => {
    makeChild([INIT, ASSISTANT("done"), RESULT_OK]);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const outcome = await driver.runOutcome({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(outcome.outcome).toBe("done");
    if (outcome.outcome === "done") {
      expect(outcome.text).toBe("done");
    }
  });

  it("scrubs API keys from stderr tail", async () => {
    // AIza + exactly 35 alphanum chars = valid key pattern
    const fakeKey = `AIza${"A".repeat(35)}`;
    const secretStderr = `error: ${fakeKey} is bad`;
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
      stdin: null;
      stdio: unknown[];
      kill: () => void;
      unref: () => void;
      killed: boolean;
      connected: boolean;
      pid: number;
      exitCode: number | null;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.stdio = [null, stdout, stderr];
    child.killed = false;
    child.connected = false;
    child.pid = 12345;
    child.exitCode = null;
    child.kill = () => {};
    child.unref = () => {};
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );
    setTimeout(() => {
      stderr.emit("data", secretStderr);
      child.emit("close", 1);
    }, 0);
    const driver = new GeminiSubprocessDriver("gemini", log);
    const result = await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.stderrTail).not.toContain(fakeKey);
    expect(result.stderrTail).toContain("[REDACTED_API_KEY]");
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
      stdin: null;
      stdio: unknown[];
      kill: () => void;
      unref: () => void;
      killed: boolean;
      connected: boolean;
      pid: number;
      exitCode: number | null;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.stdio = [null, stdout, stderr];
    child.killed = false;
    child.connected = false;
    child.pid = 12345;
    child.exitCode = null;
    child.kill = () => {};
    child.unref = () => {};
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );

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

// LOW #9 — Gemini settings.json restoration should restore exact original
// bytes when the bridge entry did not previously exist, rather than re-parsing
// and reformatting the JSON (which loses comments and custom formatting).
describe("GeminiSubprocessDriver settings.json restoration (LOW #9)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-home-"));
    fs.mkdirSync(path.join(tmpHome, ".gemini"), { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
    log.mockReset();
    vi.mocked(spawn).mockReset();
  });

  function cleanupTmpHome() {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  function makeSettingsChild(exitCode = 0) {
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
      stdin: null;
      stdio: unknown[];
      kill: () => void;
      unref: () => void;
      killed: boolean;
      connected: boolean;
      pid: number;
      exitCode: number | null;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.stdio = [null, stdout, stderr];
    child.killed = false;
    child.connected = false;
    child.pid = 12345;
    child.exitCode = null;
    child.kill = () => child.emit("close", 1);
    child.unref = () => {};
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );
    const INIT = JSON.stringify({
      type: "init",
      session_id: "abc",
      model: "gemini-2.5-flash",
    });
    const RESULT_OK = JSON.stringify({
      type: "result",
      status: "success",
      stats: {},
    });
    setTimeout(() => {
      stdout.emit("data", `${INIT}\n${RESULT_OK}\n`);
      child.emit("close", exitCode);
    }, 0);
    return child;
  }

  it("restores verbatim original bytes when bridge key was absent (no JSON reformat)", async () => {
    // Create a settings.json with unusual formatting / unknown keys.
    // JSON.parse → JSON.stringify would normalise this to a different string.
    const settingsFile = path.join(tmpHome, ".gemini", "settings.json");
    const originalContent =
      '{\n  "someUnknownKey": true,\n  "anotherKey":   42\n}\n';
    fs.writeFileSync(settingsFile, originalContent, "utf-8");

    makeSettingsChild();
    const mcp = { url: "http://127.0.0.1:9999", authToken: "tok" };
    const driver = new GeminiSubprocessDriver("gemini", log, () => mcp);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });

    // After run: the file should be exactly the original bytes.
    const restoredContent = fs.readFileSync(settingsFile, "utf-8");
    expect(restoredContent).toBe(originalContent);
    cleanupTmpHome();
  });

  it("preserves unknown top-level keys after restoration", async () => {
    const settingsFile = path.join(tmpHome, ".gemini", "settings.json");
    const originalContent = JSON.stringify({
      customSetting: "preserved",
      nestedObj: { deep: 1 },
    });
    fs.writeFileSync(settingsFile, originalContent, "utf-8");

    makeSettingsChild();
    const mcp = { url: "http://127.0.0.1:9999", authToken: "tok" };
    const driver = new GeminiSubprocessDriver("gemini", log, () => mcp);
    await driver.run({
      prompt: "hi",
      workspace: "/tmp",
      timeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
    });

    const restored = JSON.parse(
      fs.readFileSync(settingsFile, "utf-8"),
    ) as Record<string, unknown>;
    // Unknown keys must survive.
    expect(restored["customSetting"]).toBe("preserved");
    expect((restored["nestedObj"] as Record<string, unknown>)["deep"]).toBe(1);
    // The claude-ide-bridge key we added must be gone.
    expect(
      (restored["mcpServers"] as Record<string, unknown> | undefined)?.[
        "claude-ide-bridge"
      ],
    ).toBeUndefined();
    cleanupTmpHome();
  });
});
