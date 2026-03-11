import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  deleteTerminalBuffer,
  getOrCreateBuffer,
  handleCreateTerminal,
  handleExecuteInTerminal,
  handleGetTerminalOutput,
  handleListTerminals,
  handleSendTerminalCommand,
  readLastLines,
  setOutputCaptureEnabled,
  stripAnsi,
  writeToRingBuffer,
} from "../../handlers/terminal";
import type { TerminalBuffer } from "../../types";
import { __reset, _mockTerminal } from "../__mocks__/vscode";

function freshBuffer(name = "test"): TerminalBuffer {
  return { name, lines: [], partialLine: "", writeIndex: 0, totalWritten: 0 };
}

beforeEach(() => {
  __reset();
  setOutputCaptureEnabled(false);
});

// ── stripAnsi ─────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("strips SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;32mbold green\x1b[0m")).toBe("bold green");
  });

  it("strips cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Aup")).toBe("up");
    expect(stripAnsi("\x1b[10Bdown")).toBe("down");
  });

  it("strips OSC sequences (BEL terminator)", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("strips OSC sequences (ST terminator)", () => {
    expect(stripAnsi("\x1b]2;title\x1b\\text")).toBe("text");
  });

  it("strips charset designators", () => {
    expect(stripAnsi("\x1b(Btext\x1b)0")).toBe("text");
  });

  it("strips carriage returns", () => {
    expect(stripAnsi("hello\rworld")).toBe("helloworld");
  });

  it("strips private mode sequences", () => {
    expect(stripAnsi("\x1b[?25hvisible\x1b[?25l")).toBe("visible");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips complex mixed sequences", () => {
    expect(stripAnsi("\x1b[1;32m✓\x1b[0m passing \x1b[90m(5ms)\x1b[0m")).toBe(
      "✓ passing (5ms)",
    );
  });
});

// ── writeToRingBuffer ─────────────────────────────────────────

describe("writeToRingBuffer", () => {
  it("writes complete lines", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "line1\nline2\n");
    expect(buf.lines).toEqual(["line1", "line2"]);
    expect(buf.totalWritten).toBe(2);
    expect(buf.partialLine).toBe("");
  });

  it("handles partial lines", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "partial");
    expect(buf.lines).toEqual([]);
    expect(buf.partialLine).toBe("partial");
  });

  it("completes partial line on next write", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "hel");
    writeToRingBuffer(buf, "lo\n");
    expect(buf.lines).toEqual(["hello"]);
  });

  it("strips ANSI from buffered lines", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "\x1b[31mred\x1b[0m\n");
    expect(buf.lines).toEqual(["red"]);
  });

  it("wraps around at MAX_LINES_PER_TERMINAL", () => {
    const buf = freshBuffer();
    const lines = `${Array.from({ length: 5001 }, (_, i) => `line${i}`).join("\n")}\n`;
    writeToRingBuffer(buf, lines);
    expect(buf.lines.length).toBe(5000);
    expect(buf.totalWritten).toBe(5001);
    expect(buf.writeIndex).toBe(1);
    expect(buf.lines[0]).toBe("line5000");
  });

  it("wraps multiple times correctly", () => {
    const buf = freshBuffer();
    const fill = `${Array.from({ length: 5000 }, (_, i) => `old${i}`).join("\n")}\n`;
    writeToRingBuffer(buf, fill);
    writeToRingBuffer(buf, "new0\nnew1\nnew2\n");
    expect(buf.lines[0]).toBe("new0");
    expect(buf.lines[1]).toBe("new1");
    expect(buf.lines[2]).toBe("new2");
    expect(buf.writeIndex).toBe(3);
  });
});

// ── readLastLines ─────────────────────────────────────────────

describe("readLastLines", () => {
  it("reads all lines when count >= available", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "a\nb\nc\n");
    expect(readLastLines(buf, 10)).toEqual(["a", "b", "c"]);
  });

  it("reads last N lines", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "a\nb\nc\nd\n");
    expect(readLastLines(buf, 2)).toEqual(["c", "d"]);
  });

  it("returns empty for empty buffer", () => {
    expect(readLastLines(freshBuffer(), 5)).toEqual([]);
  });

  it("handles wrap-around correctly", () => {
    const buf = freshBuffer();
    const fill = `${Array.from({ length: 5002 }, (_, i) => `L${i}`).join("\n")}\n`;
    writeToRingBuffer(buf, fill);
    const last3 = readLastLines(buf, 3);
    expect(last3).toEqual(["L4999", "L5000", "L5001"]);
  });

  it("returns empty for count=0", () => {
    const buf = freshBuffer();
    writeToRingBuffer(buf, "a\n");
    expect(readLastLines(buf, 0)).toEqual([]);
  });
});

// ── handleListTerminals ───────────────────────────────────────

describe("handleListTerminals", () => {
  it("returns empty list when no terminals", async () => {
    const result = (await handleListTerminals()) as any;
    expect(result).toEqual({
      terminals: [],
      count: 0,
      outputCaptureAvailable: false,
    });
  });

  it("lists terminals with active marking", async () => {
    const t1 = _mockTerminal({ name: "bash" });
    const t2 = _mockTerminal({ name: "node" });
    vscode.window.terminals = [t1, t2] as any;
    vscode.window.activeTerminal = t1;

    const result = (await handleListTerminals()) as any;
    expect(result.count).toBe(2);
    expect(result.terminals[0].isActive).toBe(true);
    expect(result.terminals[1].isActive).toBe(false);
  });

  it("reflects outputCaptureAvailable", async () => {
    setOutputCaptureEnabled(true);
    const result = (await handleListTerminals()) as any;
    expect(result.outputCaptureAvailable).toBe(true);
  });
});

// ── handleGetTerminalOutput ───────────────────────────────────

describe("handleGetTerminalOutput", () => {
  it("returns error when terminal not found by name", async () => {
    vscode.window.terminals = [];
    const result = (await handleGetTerminalOutput({ name: "nope" })) as any;
    expect(result.available).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when capture not enabled", async () => {
    const t = _mockTerminal({ name: "t1" });
    vscode.window.terminals = [t] as any;
    const result = (await handleGetTerminalOutput({ name: "t1" })) as any;
    expect(result.available).toBe(false);
    expect(result.error).toContain("capture not available");
  });

  it("returns error when no buffer for terminal", async () => {
    const t = _mockTerminal({ name: "t1" });
    vscode.window.terminals = [t] as any;
    setOutputCaptureEnabled(true);
    const result = (await handleGetTerminalOutput({ name: "t1" })) as any;
    expect(result.available).toBe(false);
  });

  it("returns lines on success", async () => {
    const t = _mockTerminal({ name: "t1" });
    vscode.window.terminals = [t] as any;
    setOutputCaptureEnabled(true);
    const buf = getOrCreateBuffer(t as any)!;
    writeToRingBuffer(buf, "hello\nworld\n");

    const result = (await handleGetTerminalOutput({
      name: "t1",
      lines: 10,
    })) as any;
    expect(result.available).toBe(true);
    expect(result.lines).toEqual(["hello", "world"]);
    expect(result.lineCount).toBe(2);
    expect(result.totalLinesWritten).toBe(2);

    deleteTerminalBuffer(t as any);
  });

  it("finds terminal by index", async () => {
    const t1 = _mockTerminal({ name: "a" });
    const t2 = _mockTerminal({ name: "b" });
    vscode.window.terminals = [t1, t2] as any;
    setOutputCaptureEnabled(true);
    const buf = getOrCreateBuffer(t2 as any)!;
    writeToRingBuffer(buf, "from-b\n");

    const result = (await handleGetTerminalOutput({ index: 1 })) as any;
    expect(result.available).toBe(true);
    expect(result.lines).toContain("from-b");

    deleteTerminalBuffer(t2 as any);
  });
});

// ── handleCreateTerminal ──────────────────────────────────────

describe("handleCreateTerminal", () => {
  it("creates terminal with defaults", async () => {
    const result = (await handleCreateTerminal({})) as any;
    expect(result.success).toBe(true);
    expect(vscode.window.createTerminal).toHaveBeenCalled();
  });

  it("passes name and cwd", async () => {
    await handleCreateTerminal({ name: "dev", cwd: "/tmp" });
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "dev", cwd: "/tmp" }),
    );
  });

  it("shows terminal by default", async () => {
    const mockTerm = _mockTerminal({ name: "t" });
    vi.mocked(vscode.window.createTerminal).mockReturnValue(mockTerm as any);
    await handleCreateTerminal({});
    expect(mockTerm.show).toHaveBeenCalled();
  });

  it("skips show when show=false", async () => {
    const mockTerm = _mockTerminal({ name: "t" });
    vi.mocked(vscode.window.createTerminal).mockReturnValue(mockTerm as any);
    await handleCreateTerminal({ show: false });
    expect(mockTerm.show).not.toHaveBeenCalled();
  });

  it("throws on invalid name type", async () => {
    await expect(handleCreateTerminal({ name: 123 })).rejects.toThrow(
      "name must be a string",
    );
  });

  it("throws on invalid cwd type", async () => {
    await expect(handleCreateTerminal({ cwd: 123 })).rejects.toThrow(
      "cwd must be a string",
    );
  });

  it("throws on invalid env type", async () => {
    await expect(handleCreateTerminal({ env: "bad" })).rejects.toThrow(
      "env must be an object",
    );
  });
});

// ── handleSendTerminalCommand ─────────────────────────────────

describe("handleSendTerminalCommand", () => {
  it("sends text to terminal by name", async () => {
    const t = _mockTerminal({ name: "bash" });
    vscode.window.terminals = [t] as any;
    const result = (await handleSendTerminalCommand({
      text: "ls",
      name: "bash",
    })) as any;
    expect(result.success).toBe(true);
    expect(t.sendText).toHaveBeenCalledWith("ls", true);
  });

  it("sends text by index", async () => {
    const t = _mockTerminal({ name: "zsh" });
    vscode.window.terminals = [t] as any;
    const result = (await handleSendTerminalCommand({
      text: "pwd",
      index: 0,
    })) as any;
    expect(result.success).toBe(true);
  });

  it("rejects shell metacharacters", async () => {
    const t = _mockTerminal({ name: "bash" });
    vscode.window.terminals = [t] as any;
    for (const char of [
      ";",
      "&",
      "|",
      "`",
      "$",
      "(",
      ")",
      "<",
      ">",
      "!",
      "\n",
      "\r",
    ]) {
      const result = (await handleSendTerminalCommand({
        text: `cmd${char}evil`,
        name: "bash",
      })) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain("metacharacters");
    }
  });

  it("returns error when terminal not found", async () => {
    vscode.window.terminals = [];
    const result = (await handleSendTerminalCommand({
      text: "ls",
      name: "nope",
    })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("respects addNewline=false", async () => {
    const t = _mockTerminal({ name: "t" });
    vscode.window.terminals = [t] as any;
    await handleSendTerminalCommand({
      text: "x",
      name: "t",
      addNewline: false,
    });
    expect(t.sendText).toHaveBeenCalledWith("x", false);
  });

  it("throws on non-string text", async () => {
    await expect(handleSendTerminalCommand({ text: 42 })).rejects.toThrow(
      "text must be a string",
    );
  });
});

// ── getOrCreateBuffer ─────────────────────────────────────────

describe("getOrCreateBuffer", () => {
  it("creates buffer for a terminal", () => {
    const t = _mockTerminal({ name: "bash" });
    const buf = getOrCreateBuffer(t as any);
    expect(buf).not.toBeNull();
    expect(buf?.name).toBe("bash");
    deleteTerminalBuffer(t as any);
  });

  it("returns same buffer on subsequent calls", () => {
    const t = _mockTerminal({ name: "bash" });
    const b1 = getOrCreateBuffer(t as any);
    const b2 = getOrCreateBuffer(t as any);
    expect(b1).toBe(b2);
    deleteTerminalBuffer(t as any);
  });

  it("deleteTerminalBuffer allows new buffer creation", () => {
    const t = _mockTerminal({ name: "bash" });
    const b1 = getOrCreateBuffer(t as any);
    deleteTerminalBuffer(t as any);
    const b2 = getOrCreateBuffer(t as any);
    expect(b1).not.toBe(b2);
    deleteTerminalBuffer(t as any);
  });
});

// ── handleExecuteInTerminal — BUG 2 ───────────────────────────
// When the 500ms grace timer wins Promise.race() and reader.return() is called,
// the for-await loop inside readPromise may throw if the async iterator rejects
// on forced termination. That rejection must NOT become an unhandled rejection
// (which crashes the extension host).
//
// The fix wraps the for-await in try-catch inside the readPromise IIFE so that
// readPromise never rejects — errors are swallowed and output collected so far
// is preserved.

describe("handleExecuteInTerminal — reader rejection after grace period", () => {
  it("resolves cleanly when reader throws after grace timer wins (BUG 2 fix)", async () => {
    // Build a reader whose next() blocks until forced closed, then throws.
    // This simulates VS Code's stream when the terminal is disposed mid-read.
    let forceClose!: () => void;
    const closeSignal = new Promise<void>((r) => {
      forceClose = r;
    });

    let chunkDelivered = false;
    const mockReader: AsyncIterableIterator<string> & {
      return?: () => Promise<any>;
    } = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<string>> {
        if (!chunkDelivered) {
          chunkDelivered = true;
          return { value: "some output\n", done: false };
        }
        // Block until return() triggers the close signal, then throw
        await closeSignal;
        throw new Error("Terminal disposed: iterator closed after return()");
      },
      async return(): Promise<IteratorResult<string>> {
        forceClose(); // unblocks the pending next(), which will throw
        return { value: undefined, done: true };
      },
    };

    // Mock a terminal with shell integration
    let capturedEndHandler!: (ev: any) => void;
    vi.mocked(vscode.window.onDidEndTerminalShellExecution).mockImplementation(
      (handler: any) => {
        capturedEndHandler = handler;
        return { dispose: vi.fn() };
      },
    );

    const mockExecution = {};
    const mockShellIntegration = {
      executeCommand: vi.fn(() => ({
        ...mockExecution,
        read: () => mockReader,
      })),
    };
    const terminal = {
      name: "test",
      show: vi.fn(),
      shellIntegration: mockShellIntegration,
    };
    vscode.window.terminals = [terminal] as any;
    vscode.window.activeTerminal = terminal as any;

    // Start the handler — it waits for shell execution end
    const handlerPromise = handleExecuteInTerminal({
      command: "echo hi",
      timeoutMs: 30_000,
    });

    // Let setup microtasks run so onDidEndTerminalShellExecution is registered
    await Promise.resolve();
    await Promise.resolve();

    // Fire the shell execution end event — this resolves the main wait, then the
    // 500ms grace timer starts. The grace timer will win the race because the
    // reader's next() is still blocked.
    const execution =
      mockShellIntegration.executeCommand.mock.results[0]?.value;
    capturedEndHandler({ execution, exitCode: 0 });

    // Wait for the handler to complete. The 500ms grace timer runs in real time
    // — we need to wait it out. (The handler uses real setTimeout internally.)
    const result = (await handlerPromise) as any;

    // BUG 2: without the fix, reader.return() causes next() to throw, readPromise
    // rejects, and because nobody awaits it after the race(), it becomes an
    // unhandled rejection that crashes the extension host.
    //
    // With the fix (try-catch in for-await), the handler returns successfully.
    expect(result.success).toBe(true);
    // Output collected before return() was called is preserved
    expect(result.output).toContain("some output");
  }, 10_000);
});
