import * as vscode from "vscode";
import { MAX_TRACKED_TERMINALS, MAX_LINES_PER_TERMINAL } from "../constants";
import type { TerminalBuffer } from "../types";

const terminalBuffers = new Map<vscode.Terminal, TerminalBuffer>();
let terminalOutputCapture = false;

export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=]|\r/g,
    "",
  );
}

export function writeToRingBuffer(buf: TerminalBuffer, data: string): void {
  const text = buf.partialLine + data;
  const parts = text.split("\n");

  buf.partialLine = parts.pop() ?? "";

  for (const rawLine of parts) {
    const line = stripAnsi(rawLine);
    if (buf.lines.length < MAX_LINES_PER_TERMINAL) {
      buf.lines.push(line);
    } else {
      buf.lines[buf.writeIndex] = line;
    }
    buf.writeIndex = (buf.writeIndex + 1) % MAX_LINES_PER_TERMINAL;
    buf.totalWritten++;
  }
}

export function readLastLines(buf: TerminalBuffer, count: number): string[] {
  const available = Math.min(buf.lines.length, count);
  if (available === 0) return [];

  const result: string[] = [];
  let readIdx = (buf.writeIndex - available + buf.lines.length) % buf.lines.length;
  for (let i = 0; i < available; i++) {
    result.push(buf.lines[readIdx]!);
    readIdx = (readIdx + 1) % buf.lines.length;
  }
  return result;
}

export function getOrCreateBuffer(terminal: vscode.Terminal): TerminalBuffer | null {
  const existing = terminalBuffers.get(terminal);
  if (existing) return existing;

  if (terminalBuffers.size >= MAX_TRACKED_TERMINALS) return null;

  const buf: TerminalBuffer = {
    name: terminal.name,
    lines: [],
    partialLine: "",
    writeIndex: 0,
    totalWritten: 0,
  };
  terminalBuffers.set(terminal, buf);
  return buf;
}

export function deleteTerminalBuffer(terminal: vscode.Terminal): void {
  terminalBuffers.delete(terminal);
}

export function clearAllTerminalBuffers(): void {
  terminalBuffers.clear();
}

export function setOutputCaptureEnabled(enabled: boolean): void {
  terminalOutputCapture = enabled;
}

export async function handleListTerminals(): Promise<unknown> {
  const terminals = vscode.window.terminals.map((t, i) => ({
    name: t.name,
    index: i,
    isActive: t === vscode.window.activeTerminal,
    hasOutputCapture: terminalOutputCapture && terminalBuffers.has(t),
  }));
  return {
    terminals,
    count: terminals.length,
    outputCaptureAvailable: terminalOutputCapture,
  };
}

export async function handleGetTerminalOutput(
  params: Record<string, unknown>,
): Promise<unknown> {
  const name = params.name as string | undefined;
  const index = params.index as number | undefined;
  const lineCount = Math.min(
    Math.max((params.lines as number) || 100, 1),
    MAX_LINES_PER_TERMINAL,
  );

  let terminal: vscode.Terminal | undefined;
  if (name !== undefined) {
    terminal = vscode.window.terminals.find((t) => t.name === name);
  } else if (index !== undefined) {
    terminal = vscode.window.terminals[index];
  }

  if (!terminal) {
    return {
      available: false,
      error: `Terminal not found${name ? ` with name "${name}"` : ` at index ${index}`}`,
    };
  }

  if (!terminalOutputCapture) {
    return {
      available: false,
      terminalName: terminal.name,
      error:
        "Terminal output capture not available (requires VS Code proposed API onDidWriteTerminalData)",
    };
  }

  const buf = terminalBuffers.get(terminal);
  if (!buf) {
    return {
      available: false,
      terminalName: terminal.name,
      error: "No output captured for this terminal",
    };
  }

  const lines = readLastLines(buf, lineCount);
  return {
    available: true,
    terminalName: buf.name,
    lines,
    lineCount: lines.length,
    totalLinesWritten: buf.totalWritten,
    truncated: lineCount < buf.totalWritten,
  };
}

// === Wait for Terminal Output Pattern ===

const WAIT_POLL_INTERVAL_MS = 200;
/** Lines already in the buffer to include in the first check — catches output that
 * arrived in the race window between sendTerminalCommand and this call. */
const WAIT_LOOKBACK_LINES = 50;

export async function handleWaitForTerminalOutput(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof params.pattern !== "string" || !params.pattern) {
    return { matched: false, error: "pattern must be a non-empty string" };
  }
  const patternStr = params.pattern;

  let regex: RegExp;
  try {
    regex = new RegExp(patternStr);
  } catch {
    return { matched: false, error: `Invalid regex pattern: ${JSON.stringify(patternStr)}` };
  }
  // Reject patterns prone to catastrophic backtracking when polled repeatedly:
  //   (a+)+, (a*)*, (a|a)+ style nested quantifiers
  //   (a{n,m})+ style nested quantifiers
  //   alternations with shared prefix: (ab|ac)+ (heuristic)
  if (
    /\([^)]*[+*]\)[+*?{]/.test(patternStr) ||
    /\([^)]*\{[^}]+\}\)[+*{?]/.test(patternStr) ||
    /\([^|)]+\|[^)]+\)[+*]/.test(patternStr)
  ) {
    return { matched: false, error: "Pattern contains nested or ambiguous quantifiers which can cause catastrophic backtracking. Simplify the regex." };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number"
      ? Math.min(Math.max(Math.floor(params.timeoutMs), 1_000), 300_000)
      : 30_000;

  if (!terminalOutputCapture) {
    return {
      matched: false,
      error:
        "Terminal output capture is not available. " +
        "This feature requires the VS Code proposed API 'onDidWriteTerminalData'. " +
        "Reload VS Code with the extension active to enable it.",
    };
  }

  // Resolve terminal
  let terminal: vscode.Terminal | undefined;
  if (typeof params.name === "string") {
    terminal = vscode.window.terminals.find((t) => t.name === params.name);
    if (!terminal) {
      return { matched: false, error: `Terminal not found with name "${params.name}"` };
    }
  } else if (typeof params.index === "number") {
    terminal = vscode.window.terminals[params.index];
    if (!terminal) {
      return { matched: false, error: `No terminal at index ${params.index}` };
    }
  } else {
    terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return { matched: false, error: "No active terminal. Specify a terminal by name or index." };
    }
  }

  // Create buffer if not already tracked (new output will populate it)
  const buf = getOrCreateBuffer(terminal);
  if (!buf) {
    return {
      matched: false,
      error: "Maximum tracked terminals reached. Close some terminals and try again.",
    };
  }

  // Start slightly before current position to catch output that arrived just before this call
  const startFrom = Math.max(0, buf.totalWritten - WAIT_LOOKBACK_LINES);
  let lastChecked = startFrom;
  const start = Date.now();
  const terminalName = terminal.name;

  return new Promise<unknown>((resolve) => {
    let intervalId: ReturnType<typeof setInterval>;

    const finish = (result: unknown) => {
      clearInterval(intervalId);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ matched: false, aborted: true, terminalName });
    signal?.addEventListener("abort", onAbort);

    const check = () => {
      if (signal?.aborted) return; // Guard for the initial synchronous check()

      const elapsed = Date.now() - start;
      const newCount = buf.totalWritten - lastChecked;

      if (newCount > 0) {
        const lines = readLastLines(buf, newCount);
        lastChecked = buf.totalWritten;

        for (const line of lines) {
          if (regex.test(line)) {
            finish({ matched: true, matchedLine: line, elapsed: Math.round(elapsed), terminalName });
            return;
          }
        }
      }

      if (elapsed >= timeoutMs) {
        finish({ matched: false, timedOut: true, elapsed: Math.round(elapsed), terminalName });
      }
    };

    // First check immediately for lookback lines already in buffer
    check();
    intervalId = setInterval(check, WAIT_POLL_INTERVAL_MS);
  });
}

// === Synchronous Terminal Execution (Shell Integration) ===

const MAX_EXECUTE_OUTPUT_BYTES = 512 * 1024; // 500 KB cap

/** Shell metacharacters — defense-in-depth validation even though bridge validates too */
const EXEC_METACHAR_RE = /[;&|`$()<>{}!\\]/;

export async function handleExecuteInTerminal(
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof params.command !== "string" || !params.command) {
    return { success: false, error: "command must be a non-empty string" };
  }
  const command = params.command;

  if (/[\n\r]/.test(command)) {
    return { success: false, error: "Command must not contain newlines" };
  }
  if (EXEC_METACHAR_RE.test(command)) {
    return { success: false, error: "Command must not contain shell metacharacters" };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number"
      ? Math.min(Math.max(Math.floor(params.timeoutMs), 1_000), 300_000)
      : 30_000;
  const show = (params.show as boolean) ?? true;

  // Resolve terminal
  let terminal: vscode.Terminal | undefined;
  if (typeof params.name === "string") {
    terminal = vscode.window.terminals.find((t) => t.name === params.name);
    if (!terminal) {
      return { success: false, error: `Terminal not found with name "${params.name}"` };
    }
  } else if (typeof params.index === "number") {
    terminal = vscode.window.terminals[params.index];
    if (!terminal) {
      return { success: false, error: `No terminal at index ${params.index}` };
    }
  } else {
    terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "Claude" });
  }

  if (show) terminal.show();

  if (!terminal.shellIntegration) {
    return {
      success: false,
      error:
        "Shell Integration not available for this terminal. " +
        "Requires VS Code 1.93+ and a supported shell (bash, zsh, fish, PowerShell). " +
        "Try opening a new terminal — Shell Integration activates on fresh sessions.",
    };
  }

  let execution: vscode.TerminalShellExecution;
  try {
    execution = terminal.shellIntegration.executeCommand(command);
  } catch (err) {
    return {
      success: false,
      error: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const outputChunks: string[] = [];
  let outputBytes = 0;
  let truncated = false;

  // Read output concurrently with waiting for execution end
  const reader = execution.read();
  const readPromise = (async () => {
    for await (const chunk of reader) {
      if (!truncated) {
        outputBytes += chunk.length;
        if (outputBytes > MAX_EXECUTE_OUTPUT_BYTES) {
          truncated = true;
        } else {
          outputChunks.push(chunk);
        }
      }
    }
  })();

  // Wait for execution end with timeout — always resolves, never rejects
  let endDisposable: vscode.Disposable | undefined;
  const result = await new Promise<{ exitCode: number | undefined; timedOut: boolean }>(
    (resolve) => {
      const timer = setTimeout(() => {
        endDisposable?.dispose();
        resolve({ exitCode: undefined, timedOut: true });
      }, timeoutMs);

      endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return;
        clearTimeout(timer);
        endDisposable?.dispose();
        resolve({ exitCode: event.exitCode, timedOut: false });
      });
    },
  );

  // Drain any remaining buffered output (brief grace period), then terminate the iterator
  await Promise.race([readPromise, new Promise<void>((r) => setTimeout(r, 500))]);
  reader.return?.();

  const output = stripAnsi(outputChunks.join(""));

  if (result.timedOut) {
    return {
      success: false,
      error: `Command timed out after ${timeoutMs}ms`,
      timedOut: true,
      output,
      terminalName: terminal.name,
    };
  }

  return {
    success: true,
    exitCode: result.exitCode,
    output,
    truncated: truncated || undefined,
    terminalName: terminal.name,
  };
}

// === Terminal Control ===

export async function handleCreateTerminal(
  params: Record<string, unknown>,
): Promise<unknown> {
  const options: vscode.TerminalOptions = {};
  if (params.name !== undefined) {
    if (typeof params.name !== "string") throw new Error("name must be a string");
    options.name = params.name;
  }
  if (params.cwd !== undefined) {
    if (typeof params.cwd !== "string") throw new Error("cwd must be a string");
    options.cwd = params.cwd;
  }
  if (params.env !== undefined) {
    if (typeof params.env !== "object" || params.env === null || Array.isArray(params.env)) {
      throw new Error("env must be an object");
    }
    options.env = params.env as Record<string, string>;
  }

  const terminal = vscode.window.createTerminal(options);
  if (params.show !== false) terminal.show();

  const index = vscode.window.terminals.indexOf(terminal);
  return { success: true, name: terminal.name, index };
}

export async function handleDisposeTerminal(
  params: Record<string, unknown>,
): Promise<unknown> {
  const name = typeof params.name === "string" ? params.name : undefined;
  const index = typeof params.index === "number" ? params.index : undefined;

  let terminal: vscode.Terminal | undefined;
  if (name !== undefined) {
    terminal = vscode.window.terminals.find((t) => t.name === name);
  } else if (index !== undefined) {
    terminal = vscode.window.terminals[index];
  }

  if (!terminal) {
    return {
      success: false,
      error: `Terminal not found${name ? ` with name "${name}"` : ` at index ${index}`}`,
      availableTerminals: vscode.window.terminals.map((t) => t.name),
    };
  }

  const terminalName = terminal.name;
  terminal.dispose();
  return { success: true, terminalName };
}

/** Shell metacharacters that could chain or inject additional commands */
const SHELL_METACHAR_RE = /[;&|`$()<>{}!\\\n\r]/;

export async function handleSendTerminalCommand(
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof params.text !== "string") throw new Error("text must be a string");
  const text = params.text;

  // Defense-in-depth: block shell metacharacters even though the bridge validates too
  if (SHELL_METACHAR_RE.test(text)) {
    return {
      success: false,
      error: "Terminal command must not contain shell metacharacters or newlines",
    };
  }
  const name = typeof params.name === "string" ? params.name : undefined;
  const index = typeof params.index === "number" ? params.index : undefined;
  const addNewline = (params.addNewline as boolean) ?? true;

  let terminal: vscode.Terminal | undefined;
  if (name !== undefined) {
    terminal = vscode.window.terminals.find((t) => t.name === name);
  } else if (index !== undefined) {
    terminal = vscode.window.terminals[index];
  }

  if (!terminal) {
    return {
      success: false,
      error: `Terminal not found${name ? ` with name "${name}"` : ` at index ${index}`}`,
      availableTerminals: vscode.window.terminals.map((t) => t.name),
    };
  }

  terminal.sendText(text, addNewline);
  return { success: true, terminalName: terminal.name };
}
