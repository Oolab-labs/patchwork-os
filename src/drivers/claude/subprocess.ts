import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";
import { toProviderTaskOutcome } from "../types.js";
import { sanitizeEnv } from "./envSanitizer.js";
import { parseStreamLine, splitLines } from "./streamParser.js";
import { createSubprocessSettings } from "./subprocessSettings.js";

const OUTPUT_CAP = 50 * 1024; // 50KB

/**
 * Write a single-server MCP config to a 0600 temp file, return the path.
 * Caller passes path via `--mcp-config <path>` to claude -p.
 *
 * Uses the `claude-ide-bridge shim` stdio relay rather than wiring claude -p
 * straight to the bridge's HTTP MCP endpoint. claude -p (2.1.x) connects to
 * HTTP MCP servers but the spawned `Task` tool / model context never receives
 * the resulting tools — `tools/list` is skipped and `mcp__patchwork__*` tools
 * never appear in the catalog. The stdio shim sidesteps that path: claude -p
 * spawns the shim, the shim auto-discovers the running bridge from
 * `~/.claude/ide/*.lock`, and forwards JSON-RPC over stdin/stdout.
 *
 * The temp file is intentionally not deleted after the run — claude -p reads
 * it asynchronously during MCP init and unlinking too eagerly is racy. The
 * dir is created with `mkdtemp` under `os.tmpdir()` (per-run) so OS cleanup
 * handles it.
 *
 * The `mcp` parameter is currently unused at write time (the shim discovers
 * bridge state itself) but kept in the signature so callers continue to gate
 * file creation on bridge availability.
 */
function writeMcpConfigFile(_mcp: { url: string; authToken: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "patchwork-mcp-"));
  const path = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      patchwork: {
        type: "stdio",
        command: "claude-ide-bridge",
        args: ["shim"],
      },
    },
  };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

/**
 * Scrub secrets from a string before storing or surfacing it.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\btoken[=:]\s*[A-Za-z0-9._-]{16,}/gi, "token=[REDACTED]");
}

/**
 * Claude subprocess driver — spawns `claude -p` with stream-json output.
 * Claude-specific providerOptions: { effort, fallbackModel, maxBudgetUsd, useAnt, mcpAccess }
 *
 * `mcpAccess: true` is opt-in per task — the driver writes a temp `--mcp-config`
 * file pointing at the spawning bridge's HTTP MCP endpoint so the subprocess can
 * call bridge tools (getAnalyticsReport, ctxQueryTraces, etc.). Default is off
 * because most subprocess tasks shouldn't connect back to the bridge that
 * spawned them — recursion via `runClaudeTask` etc. is the failure mode.
 */
export class SubprocessDriver implements ProviderDriver {
  readonly name = "subprocess";
  private readonly settings: ReturnType<typeof createSubprocessSettings>;

  constructor(
    private readonly binary: string,
    private readonly antBinary: string,
    private readonly log: (msg: string) => void,
    private readonly bridgeMcp?: () =>
      | { url: string; authToken: string }
      | undefined,
  ) {
    this.settings = createSubprocessSettings(log);
    this.settings.write();
  }

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};
    const useAnt = opts.useAnt === true;
    const effort = typeof opts.effort === "string" ? opts.effort : undefined;
    const fallbackModel =
      typeof opts.fallbackModel === "string" ? opts.fallbackModel : undefined;
    const maxBudgetUsd =
      typeof opts.maxBudgetUsd === "number" ? opts.maxBudgetUsd : undefined;

    let effectiveBinary = useAnt ? this.antBinary : this.binary;
    // npm-installed shims on Windows are `.cmd` files. Node's spawn with
    // shell:false can't launch them via a bare name — without the explicit
    // extension every Claude subprocess spawn ENOENTs on Windows.
    if (
      process.platform === "win32" &&
      !path.extname(effectiveBinary) &&
      !effectiveBinary.includes(path.sep)
    ) {
      effectiveBinary = `${effectiveBinary}.cmd`;
    }
    // Re-write before each run — /tmp may be cleared on long-running servers.
    this.settings.write();

    // Defense-in-depth: reject argv-confusable user-controlled strings. Spawn
    // is called with an array (no shell), so this is not shell-injection
    // defense — it's argv defense for the child's flag parser, which may
    // misinterpret a leading `-` as a new flag. Mirrors the contextFiles
    // guard below.
    if (input.prompt.startsWith("-")) {
      throw new Error(
        "[SubprocessDriver] prompt cannot start with '-' (argv injection guard)",
      );
    }

    const mcpAccess = opts.mcpAccess === true;
    const mcp = mcpAccess ? this.bridgeMcp?.() : undefined;

    const args = [
      "-p",
      input.prompt,
      // --strict-mcp-config: load only the MCP servers from --mcp-config (or
      // none at all when mcpAccess is off), never ~/.claude.json or
      // .mcp.json. The strict flag also prevents claude -p from opening a
      // second session to the same bridge via a duplicate user-level entry.
      "--strict-mcp-config",
      "--settings",
      this.settings.path,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
    ];

    // Opt-in bridge MCP injection. mcpAccess + mcp resolved above the args
    // array because --strict-mcp-config behavior changes when mcpAccess is on.
    if (mcpAccess && !mcp) {
      this.log(
        "[SubprocessDriver] WARN: mcpAccess requested but bridge MCP endpoint unavailable (port not bound or feature unwired); spawning without MCP",
      );
    }
    if (mcp) {
      const mcpConfigPath = writeMcpConfigFile(mcp);
      args.push("--mcp-config", mcpConfigPath);
    }
    if (input.model && !input.model.startsWith("-")) {
      args.push("--model", input.model);
    }
    if (effort && !effort.startsWith("-")) args.push("--effort", effort);
    if (input.systemPrompt && !input.systemPrompt.startsWith("-")) {
      args.push("--system-prompt", input.systemPrompt);
    }
    if (fallbackModel && !fallbackModel.startsWith("-")) {
      args.push("--fallback-model", fallbackModel);
    }
    if (maxBudgetUsd !== undefined)
      args.push("--max-budget-usd", String(maxBudgetUsd));
    // Always skip permissions: headless subprocesses can't respond to prompts.
    args.push("--dangerously-skip-permissions");
    for (const f of input.contextFiles ?? []) {
      if (typeof f === "string" && f.length > 0 && !f.startsWith("-")) {
        args.push("--add-dir", f);
      }
    }

    const env = sanitizeEnv(process.env);

    this.log(
      `[SubprocessDriver] spawning: ${effectiveBinary} -p <prompt> (workspace: ${input.workspace})`,
    );

    const child = spawn(effectiveBinary, args, {
      cwd: input.workspace,
      env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // setsid() — prevents subprocess from opening /dev/tty for interactive prompts.
      detached: true,
    });

    let lineBuf = "";
    let accumulated = "";
    let outputBytesSent = 0;
    let firstAssistantAt: number | undefined;
    let doneFromResult = false;
    let resultText = "";
    let resultIsError = false;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const { lines, remainder } = splitLines(lineBuf, chunk);
      lineBuf = remainder;

      for (const line of lines) {
        if (line.trim() === "") continue;

        const parsed = parseStreamLine(line);
        if (parsed.kind === "raw") {
          accumulated += parsed.text;
          if (outputBytesSent < OUTPUT_CAP) {
            const send = parsed.text.slice(0, OUTPUT_CAP - outputBytesSent);
            if (send.length > 0) {
              input.onChunk?.(send);
              outputBytesSent += send.length;
            }
          }
          continue;
        }

        const { event, text } = parsed;
        if (event.type === "assistant") {
          if (firstAssistantAt === undefined) firstAssistantAt = Date.now();
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
        } else if (event.type === "result") {
          doneFromResult = true;
          resultIsError = event.is_error === true;
          resultText = text || accumulated;
        }
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_CAP) {
        stderr += chunk;
        if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(0, OUTPUT_CAP);
      }
    });

    const start = Date.now();
    const stderrTailOf = (s: string): string | undefined =>
      s.length > 0 ? scrubSecrets(s.slice(-2048)) : undefined;
    const startupMsOf = (): number | undefined =>
      firstAssistantAt !== undefined ? firstAssistantAt - start : undefined;

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

    const effectiveExitCode = doneFromResult
      ? resultIsError
        ? 1
        : 0
      : exitCode;
    const finalText = doneFromResult ? resultText : accumulated;

    if (startupTimedOut) {
      return {
        text: accumulated.slice(0, OUTPUT_CAP),
        exitCode: -1,
        durationMs: Date.now() - start,
        stderrTail: stderrTailOf(stderr),
        wasAborted: true,
        startupTimedOut: true,
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

  async runOutcome(input: ProviderTaskInput) {
    return toProviderTaskOutcome(await this.run(input));
  }
}
