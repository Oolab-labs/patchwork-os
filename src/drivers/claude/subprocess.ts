import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContainment } from "../../governance/profile.js";
import { treeKill } from "../../processTree.js";
import { ensureCmdShim } from "../../winShim.js";
import { truncateToBytes, truncateUtf8Bytes } from "../outputCap.js";
import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";
import { toProviderTaskOutcome } from "../types.js";
import {
  allowlistEnv,
  passEnvFromProviderOptions,
  sanitizeEnv,
} from "./envSanitizer.js";
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
 * The temp file is not deleted until the child CLOSES — claude -p reads it
 * asynchronously during MCP init, so unlinking any earlier is racy. The dir
 * is created with `mkdtemp` under `os.tmpdir()` (per-run); the caller
 * removes it on child close (previously it was never removed at all).
 *
 * The bridge's port is derived from `mcp.url` and pinned onto the shim via
 * `--port`, so the child attaches to the bridge that SPAWNED it rather than
 * to whichever lock file is newest (the shim's default discovery). The
 * bearer token is never written: the shim reads it from the lock file.
 */
function writeMcpConfigFile(mcp: { url: string; authToken: string }): {
  path: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "patchwork-mcp-"));
  const path = join(dir, "mcp.json");
  let port: string | undefined;
  try {
    const p = new URL(mcp.url).port;
    if (/^\d+$/.test(p)) port = p;
  } catch {
    /* unparseable url — fall back to shim discovery */
  }
  // claude -p spawns the stdio command itself via Node's child_process, which
  // can't resolve a bare `.cmd` shim on Windows (shell:false; only PATHEXT-
  // listed `.exe` files auto-resolve). Record the `.cmd` form on win32 so
  // claude -p can find the bridge binary that npm installed.
  const config = {
    mcpServers: {
      patchwork: {
        type: "stdio",
        command: ensureCmdShim("claude-ide-bridge"),
        args: port ? ["shim", "--port", port] : ["shim"],
      },
    },
  };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { path, dir };
}

/**
 * Accept a containment either typed on the input or repackaged into the
 * untyped providerOptions bag (the orchestrator hop). Shape-checked, never
 * trusted blindly: a malformed object is ignored rather than half-applied.
 */
export function containmentFromInput(
  input: Pick<ProviderTaskInput, "containment" | "providerOptions">,
): AgentContainment | undefined {
  const c = input.containment ?? input.providerOptions?.containment;
  if (!c || typeof c !== "object") return undefined;
  const o = c as Partial<AgentContainment>;
  if (typeof o.enforced !== "boolean") return undefined;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  return {
    enforced: o.enforced,
    allowedTools: strs(o.allowedTools),
    deniedTools: strs(o.deniedTools),
    envAllowlist: o.envAllowlist === true,
    mcpAccess: o.mcpAccess === true,
    widenings: strs(o.widenings),
  };
}

/** Provider credentials the Claude CLI authenticates with. */
export const CLAUDE_PROVIDER_ENV_KEYS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

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
  /** Contained-run settings files, keyed by their deny set. */
  private readonly containedSettings = new Map<
    string,
    ReturnType<typeof createSubprocessSettings>
  >();

  constructor(
    private readonly binary: string,
    private readonly antBinary: string,
    private readonly log: (msg: string) => void,
    private readonly bridgeMcp?: () =>
      | { url: string; authToken: string }
      | undefined,
  ) {
    this.settings = createSubprocessSettings(log);
    // Best-effort initial write; per-run write in run() is the enforcement gate.
    this.settings.write();
  }

  private settingsFor(
    deniedTools: readonly string[],
  ): ReturnType<typeof createSubprocessSettings> {
    const key = [...deniedTools].sort().join("\u0000");
    let s = this.containedSettings.get(key);
    if (!s) {
      s = createSubprocessSettings(this.log, deniedTools);
      this.containedSettings.set(key, s);
    }
    return s;
  }

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};
    const useAnt = opts.useAnt === true;
    const effort = typeof opts.effort === "string" ? opts.effort : undefined;
    const fallbackModel =
      typeof opts.fallbackModel === "string" ? opts.fallbackModel : undefined;
    const maxBudgetUsd =
      typeof opts.maxBudgetUsd === "number" ? opts.maxBudgetUsd : undefined;

    // npm-installed shims on Windows are `.cmd` files. Node's spawn with
    // shell:false can't launch them via a bare name — without the explicit
    // extension every Claude subprocess spawn ENOENTs on Windows.
    const effectiveBinary = ensureCmdShim(
      useAnt ? this.antBinary : this.binary,
    );
    // Re-write before each run — /tmp may be cleared on long-running servers.
    // M11: abort if write fails — spawning without the settings file would run
    // claude -p without the deny list, bypassing the command block entirely.
    // Phase 0 step 6: containment resolved by the caller (agentExecutor via
    // `resolveAgentContainment`). Absent ⇒ legacy providerOptions keys below.
    const containment = containmentFromInput(input);
    const contained = containment?.enforced === true;
    const settings = contained
      ? this.settingsFor(containment?.deniedTools ?? [])
      : this.settings;
    if (!settings.write()) {
      throw new Error(
        "[SubprocessDriver] Failed to write settings file — cannot spawn claude -p without deny list",
      );
    }

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

    // With a containment present, ITS mcpAccess is the decision — a step
    // cannot reach the bridge's tool surface by setting the legacy key alone.
    const mcpAccess = containment
      ? containment.mcpAccess
      : opts.mcpAccess === true;
    const mcp = mcpAccess ? this.bridgeMcp?.() : undefined;

    // P0-5 opt-in tool sandbox. Filter argv-injection-confusable values up front
    // (leading `-` could be misread as a flag by the child's parser), then key
    // the sandbox branch off the FILTERED allowlist being non-empty.
    const argvSafe = (list: unknown): string[] =>
      (Array.isArray(list) ? (list as unknown[]) : []).filter(
        (t): t is string =>
          typeof t === "string" && t.length > 0 && !t.startsWith("-"),
      );
    const sandbox = opts.sandbox === true;
    const allowedTools = contained
      ? argvSafe(containment?.allowedTools)
      : argvSafe(opts.allowedTools);
    // Deny is a union: the step's own list plus the containment's. A deny is
    // never dropped by the presence of a containment.
    const disallowedTools = Array.from(
      new Set([
        ...argvSafe(opts.disallowedTools),
        ...(contained ? argvSafe(containment?.deniedTools) : []),
      ]),
    );
    // Contained: permission mode is dontAsk even with an EMPTY allowlist
    // (every tool call is then refused — the correct contained outcome).
    // Legacy: the sandbox branch keys off a non-empty allowlist, as before.
    const sandboxActive = contained || (sandbox && allowedTools.length > 0);

    const args = [
      "-p",
      input.prompt,
      // --strict-mcp-config: load only the MCP servers from --mcp-config (or
      // none at all when mcpAccess is off), never ~/.claude.json or
      // .mcp.json. The strict flag also prevents claude -p from opening a
      // second session to the same bridge via a duplicate user-level entry.
      "--strict-mcp-config",
      "--settings",
      settings.path,
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
    let mcpTmpDir: string | undefined;
    if (mcp) {
      const written = writeMcpConfigFile(mcp);
      mcpTmpDir = written.dir;
      args.push("--mcp-config", written.path);
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
    if (sandboxActive) {
      // Sandbox: enforce the allowlist. --dangerously-skip-permissions VOIDS
      // --allowed-tools (per CC docs), so they are mutually exclusive — drop
      // skip-permissions and run in dontAsk mode (no interactive prompt, but
      // permission rules are honored). --allowed-tools is variadic: push the
      // flag once followed by all (already argv-filtered) tool values.
      args.push("--permission-mode", "dontAsk");
      if (allowedTools.length > 0) {
        args.push("--allowed-tools", ...allowedTools);
      }
    } else {
      // Default (no sandbox): headless subprocesses can't respond to prompts.
      args.push("--dangerously-skip-permissions");
    }
    // Deny rules apply in ANY mode — even under --dangerously-skip-permissions.
    // --disallowed-tools is variadic: one flag, all (filtered) values.
    if (disallowedTools.length > 0) {
      args.push("--disallowed-tools", ...disallowedTools);
    }
    for (const f of input.contextFiles ?? []) {
      if (typeof f === "string" && f.length > 0 && !f.startsWith("-")) {
        args.push("--add-dir", f);
      }
    }

    // Governed containment: ALLOWLIST the environment (only PATH/HOME/locale/
    // proxy/etc., the Claude credential, and the recipe's declared passEnv).
    // Otherwise the pre-profile denylist, unchanged.
    const env = containment?.envAllowlist
      ? allowlistEnv(process.env, {
          providerKeys: CLAUDE_PROVIDER_ENV_KEYS,
          passEnv: passEnvFromProviderOptions(opts),
        })
      : sanitizeEnv(process.env);

    this.log(
      `[SubprocessDriver] spawning: ${effectiveBinary} -p <prompt> (workspace: ${input.workspace}${contained ? `, contained: allowed=[${allowedTools.join(",")}] denied=[${disallowedTools.join(",")}] widenings=[${(containment?.widenings ?? []).join(",")}]` : ""})`,
    );

    const child = spawn(effectiveBinary, args, {
      cwd: input.workspace,
      env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // setsid() — prevents subprocess from opening /dev/tty for interactive prompts.
      detached: true,
    });
    // Node's `signal` option calls `child.kill()` on abort, which only signals
    // the immediate child. claude -p may itself spawn children (MCP shims,
    // tools); without tree-kill those orphan when the task is cancelled.
    // On POSIX this kills the process group (setsid above); on Windows it
    // runs `taskkill /F /T /PID`. Idempotent with Node's auto-kill.
    const onAbort = () => treeKill(child);
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => {
      input.signal.removeEventListener("abort", onAbort);
      // Safe to remove now: claude -p has finished reading the MCP config.
      if (mcpTmpDir) {
        try {
          rmSync(mcpTmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    let lineBuf = "";
    let accumulated = "";
    let outputBytesSent = 0;
    let firstAssistantAt: number | undefined;
    let doneFromResult = false;
    let resultText = "";
    let resultIsError = false;
    // P0-4: capture the result event's usage/cost telemetry (previously
    // discarded). Surfaced via providerMeta so the existing
    // providerMetaToUsage → RunBudget.reconcile path (and the runlog) sees real
    // token usage for claude -p steps instead of zero. `subprocess` is not a
    // BILLABLE_DRIVER, so usdMax stays fail-open — this only surfaces telemetry.
    let resultUsage:
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    let resultCostUsd: number | undefined;
    let resultNumTurns: number | undefined;
    let resultDurationMs: number | undefined;
    const providerMetaOf = (): Record<string, unknown> | undefined => {
      const meta: Record<string, unknown> = {};
      const inT = resultUsage?.input_tokens;
      const outT = resultUsage?.output_tokens;
      if (typeof inT === "number" && typeof outT === "number") {
        meta.inputTokens = inT;
        meta.outputTokens = outT;
      }
      if (typeof resultCostUsd === "number") meta.costUsd = resultCostUsd;
      if (typeof resultNumTurns === "number") meta.numTurns = resultNumTurns;
      if (typeof resultDurationMs === "number") {
        meta.durationMs = resultDurationMs;
      }
      if (typeof input.model === "string" && input.model.length > 0) {
        meta.model = input.model;
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    };

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
            const { send, bytes } = truncateToBytes(
              parsed.text,
              OUTPUT_CAP - outputBytesSent,
            );
            if (bytes > 0) {
              input.onChunk?.(send);
              outputBytesSent += bytes;
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
              const { send, bytes } = truncateToBytes(
                text,
                OUTPUT_CAP - outputBytesSent,
              );
              if (bytes > 0) {
                input.onChunk?.(send);
                outputBytesSent += bytes;
              }
            }
          }
        } else if (event.type === "result") {
          doneFromResult = true;
          resultIsError = event.is_error === true;
          resultText = text || accumulated;
          resultUsage = event.usage;
          resultCostUsd = event.total_cost_usd;
          resultNumTurns = event.num_turns;
          resultDurationMs = event.duration_ms;
        }
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Apply the same byte-budget cap to stderr to prevent unbounded memory
      // growth on multi-byte UTF-8 output. Counting via Buffer.byteLength /
      // truncateUtf8Bytes keeps the cap a true byte budget rather than a
      // UTF-16 code-unit budget.
      if (Buffer.byteLength(stderr, "utf8") < OUTPUT_CAP) {
        stderr += chunk;
        if (Buffer.byteLength(stderr, "utf8") > OUTPUT_CAP) {
          stderr = truncateUtf8Bytes(stderr, OUTPUT_CAP);
        }
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
            treeKill(child);
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
          text: truncateUtf8Bytes(resultText, OUTPUT_CAP),
          exitCode: resultIsError ? 1 : 0,
          durationMs: Date.now() - start,
          stderrTail: stderrTailOf(stderr),
          startupMs: startupMsOf(),
          providerMeta: providerMetaOf(),
        };
      }
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        input.signal.aborted;
      if (isAbort) {
        return {
          text: truncateUtf8Bytes(accumulated, OUTPUT_CAP),
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

    // Flush any partial line remaining in lineBuf after stdout closes.
    // splitLines() leaves content without a trailing '\n' in the remainder;
    // when the subprocess exits without a final newline the last JSON event
    // (e.g. the result event) is silently dropped. Process it now.
    if (lineBuf.trim().length > 0) {
      const parsed = parseStreamLine(lineBuf);
      if (parsed.kind === "raw") {
        accumulated += parsed.text;
        if (outputBytesSent < OUTPUT_CAP) {
          const { send, bytes } = truncateToBytes(
            parsed.text,
            OUTPUT_CAP - outputBytesSent,
          );
          if (bytes > 0) {
            input.onChunk?.(send);
            outputBytesSent += bytes;
          }
        }
      } else {
        const { event, text } = parsed;
        if (event.type === "assistant") {
          if (firstAssistantAt === undefined) firstAssistantAt = Date.now();
          if (text.length > 0) {
            accumulated += text;
            if (outputBytesSent < OUTPUT_CAP) {
              const { send, bytes } = truncateToBytes(
                text,
                OUTPUT_CAP - outputBytesSent,
              );
              if (bytes > 0) {
                input.onChunk?.(send);
                outputBytesSent += bytes;
              }
            }
          }
        } else if (event.type === "result") {
          doneFromResult = true;
          resultIsError = event.is_error === true;
          resultText = text || accumulated;
          resultUsage = event.usage;
          resultCostUsd = event.total_cost_usd;
          resultNumTurns = event.num_turns;
          resultDurationMs = event.duration_ms;
        }
      }
      lineBuf = "";
    }

    const effectiveExitCode = doneFromResult
      ? resultIsError
        ? 1
        : 0
      : exitCode;
    const finalText = doneFromResult ? resultText : accumulated;

    if (startupTimedOut) {
      return {
        text: truncateUtf8Bytes(accumulated, OUTPUT_CAP),
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
      text: truncateUtf8Bytes(finalText, OUTPUT_CAP),
      exitCode: effectiveExitCode,
      durationMs: Date.now() - start,
      stderrTail: stderrTailOf(stderr),
      startupMs: startupMsOf(),
      providerMeta: providerMetaOf(),
    };
  }

  async runOutcome(input: ProviderTaskInput) {
    return toProviderTaskOutcome(await this.run(input));
  }
}
