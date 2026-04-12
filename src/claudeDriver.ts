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
}

export interface ClaudeTaskOutput {
  text: string;
  exitCode: number;
  durationMs: number;
}

export interface IClaudeDriver {
  readonly name: string;
  run(input: ClaudeTaskInput): Promise<ClaudeTaskOutput>;
  /** Optional lifecycle hooks — no-op in SubprocessDriver. */
  spawnForSession?(sessionId: string): Promise<void>;
  killForSession?(sessionId: string): void;
}

const OUTPUT_CAP = 50 * 1024; // 50KB

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
          "Bash(npm publish*)",
          "Bash(npm version*)",
          "Bash(yarn publish*)",
          "Bash(pnpm publish*)",
          "Bash(git push*)",
          "Bash(git tag*)",
          "Bash(gh release*)",
          "Bash(npx semantic-release*)",
          "Bash(npx release-it*)",
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
    ];
    if (input.model) args.push("--model", input.model);
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

    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const prevLen = output.length;
      if (prevLen >= OUTPUT_CAP) return; // already at cap — discard to prevent unbounded growth
      output += chunk;
      // Only forward chunks until we hit the cap — avoids flooding callers on large output
      if (output.length <= OUTPUT_CAP) {
        // Entire chunk fits within cap
        input.onChunk?.(chunk);
      } else {
        // Partial chunk: send only the portion up to the cap; truncate accumulator
        const remaining = chunk.slice(0, OUTPUT_CAP - prevLen);
        if (remaining.length > 0) input.onChunk?.(remaining);
        output = output.slice(0, OUTPUT_CAP);
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
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", reject);
    });

    if (exitCode !== 0 && stderr) {
      this.log(`[SubprocessDriver] stderr: ${stderr.slice(0, 500)}`);
    }

    return {
      text: output.slice(0, OUTPUT_CAP),
      exitCode,
      durationMs: Date.now() - start,
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
