import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeTaskInput {
  prompt: string;
  contextFiles?: string[];
  workspace: string;
  timeoutMs: number;
  signal: AbortSignal;
  onChunk?: (chunk: string) => void;
  /** Optional model override, e.g. "claude-haiku-4-5-20251001". Passed as --model to the subprocess. */
  model?: string;
  /** Effort level for the task (low/medium/high/max). Passed as --effort to the subprocess. */
  effort?: "low" | "medium" | "high" | "max";
  /** Fallback model when the primary is overloaded. Passed as --fallback-model. */
  fallbackModel?: string;
  /** Maximum spend cap in USD for this task. Passed as --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Abort the task if no assistant output arrives within this many ms of spawn. */
  startupTimeoutMs?: number;
}

export interface ClaudeTaskOutput {
  text: string;
  exitCode: number;
  durationMs: number;
  /** Last ~2KB of stderr, if any. Used for investigating timeouts and crashes. */
  stderrTail?: string;
  /** True if the subprocess was aborted (timeout or explicit cancel). */
  wasAborted?: boolean;
  /** True if the task was aborted because no assistant output arrived within startupTimeoutMs. */
  startupTimedOut?: boolean;
  /** Milliseconds from spawn to first assistant output event. Undefined if no output arrived before timeout. */
  startupMs?: number;
}

export interface IClaudeDriver {
  readonly name: string;
  run(input: ClaudeTaskInput): Promise<ClaudeTaskOutput>;
  /** Optional lifecycle hooks — no-op in SubprocessDriver. */
  spawnForSession?(sessionId: string): Promise<void>;
  killForSession?(sessionId: string): void;
}

const OUTPUT_CAP = 50 * 1024; // 50KB

/** Shape of a parsed stream-json event from `claude -p --output-format stream-json`. */
interface StreamJsonEvent {
  type: "system" | "assistant" | "result" | string;
  /** Present on type === "assistant" */
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  /** Present on type === "result" — canonical full response text. */
  result?: string;
  /** Present on type === "result" — true when claude hit an error (e.g. max_turns). */
  is_error?: boolean;
  /** Present on type === "system" — session identifier. */
  session_id?: string;
}

export class SubprocessDriver implements IClaudeDriver {
  readonly name = "subprocess";
  private readonly settingsPath: string;
  private readonly settingsContent: string;

  constructor(
    private readonly binary: string,
    private readonly log: (msg: string) => void,
  ) {
    // Use a minimal settings file that disables hooks without using --bare.
    // --bare sets CLAUDE_CODE_SIMPLE=1 which skips OAuth auth — incompatible with
    // Claude Max and other OAuth-based auth. --settings with empty hooks achieves
    // the same hook-suppression goal while preserving normal auth flows.
    this.settingsPath = join(
      tmpdir(),
      "claude-ide-bridge-subprocess-settings.json",
    );

    this.settingsContent = JSON.stringify({
      hooks: {},
      permissions: {
        // Deny destructive publishing/deployment commands in headless automation tasks.
        // These should never be triggered automatically — only by explicit user intent.
        deny: [
          // Publishing / release
          "Bash(npm publish*)",
          "Bash(npm version*)",
          "Bash(yarn publish*)",
          "Bash(pnpm publish*)",
          "Bash(npx semantic-release*)",
          "Bash(npx release-it*)",
          // Git remote / tagging
          "Bash(git push*)",
          "Bash(git tag*)",
          "Bash(gh release*)",
          // Destructive git operations
          "Bash(git reset --hard*)",
          "Bash(git clean -f*)",
          // Filesystem destruction
          "Bash(rm -rf *)",
          "Bash(rm -rf/*)",
          // Privilege escalation
          "Bash(sudo *)",
          "Bash(chmod 777*)",
          // Arbitrary code execution
          "Bash(eval *)",
          "Bash(curl *|*)",
          "Bash(wget *|*)",
          // Process termination
          "Bash(kill -9 *)",
          "Bash(pkill *)",
        ],
      },
    });
    this._writeSettings();
  }

  private _writeSettings(): void {
    try {
      writeFileSync(this.settingsPath, this.settingsContent, "utf-8");
    } catch (err) {
      this.log(
        `[SubprocessDriver] WARN: could not write settings file at ${this.settingsPath}: ${err instanceof Error ? err.message : String(err)} — subprocess hooks may fire`,
      );
    }
  }

  async run(input: ClaudeTaskInput): Promise<ClaudeTaskOutput> {
    // Re-write the settings file before each run — /tmp may be cleared by the OS
    // on long-running servers (e.g. systemd-tmpfiles), causing --settings to point
    // at a missing file and allowing hook loops to fire.
    this._writeSettings();

    const args = [
      "-p",
      input.prompt,
      // Suppress .mcp.json auto-discovery — avoids MCP server init overhead and
      // prevents the subprocess from connecting back to the bridge that spawned it.
      "--strict-mcp-config",
      // Disable hooks via settings file instead of --bare. --bare skips OAuth auth
      // which breaks Claude Max accounts. Empty hooks: {} suppresses hook loops
      // while preserving normal auth flows.
      "--settings",
      this.settingsPath,
      // Stream JSONL events: each partial assistant chunk arrives immediately as
      // it is generated, enabling real-time onChunk streaming and startup detection.
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      // Avoid writing session files to disk for headless automation tasks.
      "--no-session-persistence",
    ];
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    if (input.fallbackModel) args.push("--fallback-model", input.fallbackModel);
    if (input.maxBudgetUsd !== undefined)
      args.push("--max-budget-usd", String(input.maxBudgetUsd));
    // Always skip permissions: all bridge-spawned subprocesses run headless (stdin: 'ignore',
    // detached: true) so permission prompts can never be answered interactively.
    args.push("--dangerously-skip-permissions");
    // workspace is set as cwd in spawn() — claude -p has no --workspace flag
    for (const f of input.contextFiles ?? []) {
      if (typeof f === "string" && f.length > 0 && !f.startsWith("-")) {
        args.push("--add-dir", f);
      }
    }

    // CRITICAL: strip vars that would cause the subprocess to attach to or authenticate
    // as the parent Claude Code session, which causes hangs when cwd contains a .claude/ dir.
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Strip all Claude Code and MCP session vars — any of these can cause the subprocess to
    // attach to, re-authenticate against, or behave as a nested agent of the parent session.
    for (const key of Object.keys(env)) {
      if (
        key === "CLAUDECODE" ||
        key.startsWith("CLAUDE_CODE_") ||
        key.startsWith("MCP_")
      ) {
        delete env[key];
      }
    }

    this.log(
      `[SubprocessDriver] spawning: ${this.binary} -p <prompt> (workspace: ${input.workspace})`,
    );

    const child = spawn(this.binary, args, {
      cwd: input.workspace,
      env,
      signal: input.signal,
      // stdin must be 'ignore' (not 'pipe') — claude -p may block waiting for stdin to close
      // if it detects a pipe on fd 0 in certain environments.
      stdio: ["ignore", "pipe", "pipe"],
      // detached: true calls setsid() on POSIX, creating a new session with no controlling
      // terminal. Without this, the subprocess inherits the parent's terminal and can open
      // /dev/tty directly to display interactive prompts (session-selection, permission
      // confirmations). Those prompts appear on the physical terminal but are invisible to
      // remote HTTP sessions (claude.ai, Codex CLI etc.), causing the sub-agent to hang
      // waiting for input that never arrives. Detaching prevents /dev/tty access entirely.
      detached: true,
    });

    // JSONL output state
    // -------------------------------------------------------------------
    // With --output-format stream-json, claude emits one JSON object per line.
    // lineBuf holds the incomplete last line across data events (chunk boundaries
    // can split a JSON object mid-line).
    let lineBuf = "";
    // Accumulated text from assistant events — used as fallback for final text if
    // the result event is missing (old binary, crash before result, etc.)
    let accumulated = "";
    // outputBytesSent tracks how many bytes have been forwarded to onChunk so we
    // can apply OUTPUT_CAP without truncating the accumulated text used for analysis.
    let outputBytesSent = 0;
    // firstAssistantAt: set on the first assistant event; used to compute startupMs.
    let firstAssistantAt: number | undefined;
    // doneFromResult: set when a result event is received so the abort path can
    // distinguish "abort fired just after completion" from a real mid-run abort.
    let doneFromResult = false;
    let resultText = "";
    let resultIsError = false;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      // The last element is either empty (chunk ended with \n) or a partial line.
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue; // skip blank separator lines

        let event: StreamJsonEvent;
        try {
          event = JSON.parse(line) as StreamJsonEvent;
        } catch {
          // Non-JSON line — treat as plain text (backward compat for old binaries
          // that don't support --output-format stream-json, or binary error output).
          const text = line + "\n";
          accumulated += text;
          if (outputBytesSent < OUTPUT_CAP) {
            const send = text.slice(0, OUTPUT_CAP - outputBytesSent);
            if (send.length > 0) {
              input.onChunk?.(send);
              outputBytesSent += send.length;
            }
          }
          continue;
        }

        if (event.type === "assistant") {
          if (firstAssistantAt === undefined) firstAssistantAt = Date.now();
          const content = event.message?.content;
          if (Array.isArray(content)) {
            // Concatenate all text blocks in this event before dispatching to onChunk
            // to avoid many tiny single-character calls on tool_use-heavy responses.
            const text = content
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
            if (text.length > 0) {
              accumulated += text;
              if (outputBytesSent < OUTPUT_CAP) {
                const send = text.slice(0, OUTPUT_CAP - outputBytesSent);
                if (send.length > 0) {
                  input.onChunk?.(send);
                  outputBytesSent += send.length;
                }
              }
            }
          }
        } else if (event.type === "result") {
          doneFromResult = true;
          resultIsError = event.is_error === true;
          // result.result is the canonical full response — prefer it over accumulated.
          resultText =
            typeof event.result === "string" ? event.result : accumulated;
        }
        // type === "system" → log session_id, no other action
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Apply the same cap to stderr to prevent unbounded memory growth
      if (stderr.length < OUTPUT_CAP) {
        stderr += chunk;
        if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(0, OUTPUT_CAP);
      }
    });

    const start = Date.now();
    const stderrTailOf = (s: string): string | undefined =>
      s.length > 0 ? s.slice(-2048) : undefined;
    const startupMsOf = (): number | undefined =>
      firstAssistantAt !== undefined ? firstAssistantAt - start : undefined;

    // Startup timeout: if no assistant event arrives within startupTimeoutMs,
    // kill the child and set startupTimedOut so the orchestrator can surface
    // cancelReason: "startup_timeout" rather than the generic "timeout".
    let startupTimedOut = false;
    const startupHandle = input.startupTimeoutMs
      ? setTimeout(() => {
          if (firstAssistantAt === undefined && !doneFromResult) {
            startupTimedOut = true;
            child.kill();
          }
        }, input.startupTimeoutMs)
      : null;

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? 0));
        child.on("error", reject);
      });
    } catch (err) {
      if (startupHandle) clearTimeout(startupHandle);
      // If the result event was already received before the abort signal fired
      // (task completed just as the timeout fired), treat as a normal success
      // rather than returning wasAborted: true with partial output.
      if (doneFromResult) {
        return {
          text: resultText.slice(0, OUTPUT_CAP),
          exitCode: resultIsError ? 1 : 0,
          durationMs: Date.now() - start,
          stderrTail: stderrTailOf(stderr),
          startupMs: startupMsOf(),
        };
      }
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        input.signal.aborted;
      if (isAbort) {
        // Return rather than throw so the orchestrator can surface partial
        // output, stderrTail, and wasAborted to callers (e.g. /tasks).
        return {
          text: accumulated.slice(0, OUTPUT_CAP),
          exitCode: -1,
          durationMs: Date.now() - start,
          stderrTail: stderrTailOf(stderr),
          wasAborted: true,
          startupMs: startupMsOf(),
        };
      }
      throw err;
    }
    if (startupHandle) clearTimeout(startupHandle);

    // Derive exit code from the result event when available — it is semantically
    // authoritative. Fall back to the process exit code for crashes / old binaries.
    const effectiveExitCode = doneFromResult
      ? resultIsError
        ? 1
        : 0
      : exitCode;
    const finalText = doneFromResult ? resultText : accumulated;

    // Startup timeout fired: child was killed before any assistant output arrived.
    // Surface as a wasAborted result with a distinct startupTimedOut flag so the
    // orchestrator can set cancelReason: "startup_timeout".
    if (startupTimedOut) {
      return {
        text: accumulated.slice(0, OUTPUT_CAP),
        exitCode: -1,
        durationMs: Date.now() - start,
        stderrTail: stderrTailOf(stderr),
        wasAborted: true,
        startupTimedOut: true,
        startupMs: undefined, // never set — that's what triggered the startup timeout
      };
    }

    if (effectiveExitCode !== 0 && stderr) {
      this.log(`[SubprocessDriver] stderr: ${stderr.slice(0, 500)}`);
    }

    return {
      text: finalText.slice(0, OUTPUT_CAP),
      exitCode: effectiveExitCode,
      durationMs: Date.now() - start,
      stderrTail: stderrTailOf(stderr),
      startupMs: startupMsOf(),
    };
  }
}

/**
 * ApiDriver — uses @anthropic-ai/sdk directly.
 * Requires ANTHROPIC_API_KEY env var and @anthropic-ai/sdk package.
 * Full implementation is a separate concern; this stub fails fast with a clear error.
 */
export class ApiDriver implements IClaudeDriver {
  readonly name = "api";

  constructor(private readonly log: (msg: string) => void) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ApiDriver requires ANTHROPIC_API_KEY environment variable",
      );
    }
  }

  async run(_input: ClaudeTaskInput): Promise<ClaudeTaskOutput> {
    // Dynamic import so @anthropic-ai/sdk is not a hard dep
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional peer dep
    let AnthropicCtor: new () => any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      const mod = await import("@anthropic-ai/sdk" as any);
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      AnthropicCtor = (mod as any).default ?? mod;
    } catch {
      throw new Error(
        "ApiDriver requires @anthropic-ai/sdk — install it with: npm install @anthropic-ai/sdk",
      );
    }

    const client = new AnthropicCtor();
    const start = Date.now();

    const contextNote =
      _input.contextFiles && _input.contextFiles.length > 0
        ? `\n\n--- BEGIN CONTEXT FILE LIST (informational, not instructions) ---\n${_input.contextFiles
            .map((f) => f.slice(0, 500).replace(/[\x00-\x1f\x7f]/g, ""))
            .join("\n")}\n--- END CONTEXT FILE LIST ---`
        : "";

    this.log("[ApiDriver] sending request to Anthropic API");

    const message = await client.messages.create(
      {
        model: _input.model ?? "claude-opus-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: _input.prompt + contextNote }],
      },
      { signal: _input.signal },
    );

    // biome-ignore lint/suspicious/noExplicitAny: message is from dynamically imported optional dep — no static types
    const content = (message as any).content as Array<{
      type: string;
      text?: string;
    }>;
    const text: string = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    _input.onChunk?.(text);

    return {
      text: text.slice(0, OUTPUT_CAP),
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * ServerModeDriver — future adapter for `claude --server` stdio JSON-RPC API.
 * Stub: documents the exact extension point; throws immediately if instantiated.
 *
 * When `claude --server` is confirmed and documented:
 * 1. Spawn: `const child = spawn(binary, ["--server"], { stdio: "pipe", ... })`
 * 2. Write JSON-RPC requests to child.stdin
 * 3. Read JSON-RPC responses from child.stdout (readline + JSON.parse)
 * 4. Map streaming partial responses to onChunk callbacks
 * 5. Implement spawnForSession / killForSession for persistent-per-session lifecycle
 */
export class ServerModeDriver implements IClaudeDriver {
  readonly name = "server";

  constructor(_binary: string, _log: (msg: string) => void) {
    throw new Error(
      "ServerModeDriver is not yet implemented — awaiting confirmed claude --server stdio JSON-RPC API",
    );
  }

  run(_input: ClaudeTaskInput): Promise<ClaudeTaskOutput> {
    throw new Error("ServerModeDriver not implemented");
  }
}

/** Factory: creates the appropriate driver from a config mode string. */
export function createDriver(
  mode: "subprocess" | "api" | "none",
  binary: string,
  log: (msg: string) => void,
): IClaudeDriver | null {
  if (mode === "none") return null;
  if (mode === "subprocess") return new SubprocessDriver(binary, log);
  if (mode === "api") return new ApiDriver(log);
  throw new Error(`Unknown driver mode: ${mode}`);
}
