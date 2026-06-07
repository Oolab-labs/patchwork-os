import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { treeKill } from "../../processTree.js";
import { ensureCmdShim } from "../../winShim.js";
import { sanitizeEnv } from "../claude/envSanitizer.js";
import { splitLines } from "../claude/streamParser.js";
import { truncateToBytes, truncateUtf8Bytes } from "../outputCap.js";
import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";
import { toProviderTaskOutcome } from "../types.js";

const OUTPUT_CAP = 50 * 1024;

/**
 * Gemini stream-json event shapes (v0.38+).
 * init    — session start, contains session_id + model
 * message — user or assistant turn; assistant chunks have delta: true
 * result  — final summary with status + stats
 */
interface GeminiEvent {
  type: "init" | "message" | "result" | string;
  role?: "user" | "assistant";
  content?: string;
  /** True on streaming assistant chunks */
  delta?: boolean;
  status?: "success" | "error" | string;
  session_id?: string;
  model?: string;
}

function scrubSecrets(text: string): string {
  return text
    .replace(/AIza[A-Za-z0-9_-]{35}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [REDACTED]");
}

/**
 * GeminiSubprocessDriver — spawns `gemini -p` with --output-format stream-json.
 * Auth: GEMINI_API_KEY env var (or gcloud ADC / Vertex if configured in ~/.gemini/settings.json).
 * providerOptions: { approvalMode?: "yolo" | "auto_edit" | "default" | "plan" }
 */
export class GeminiSubprocessDriver implements ProviderDriver {
  readonly name = "gemini";

  /**
   * Process-wide serialization for `~/.gemini/settings.json` mutation. Two
   * concurrent `run()` invocations would otherwise race:
   *
   *   A reads file (originalContent = X)
   *   A writes A's-token
   *   B reads file (originalContent = A's-token)   ← B captures wrong baseline
   *   B writes B's-token
   *   A's child starts, reads settings — sees B's-token (uses wrong creds)
   *   A finishes, restores to X (wipes B's token mid-flight)
   *   B's child reads settings — sees X (no MCP config)
   *   B finishes, restores to A's-token (token leaks past run)
   *
   * The settings file is global to ~/.gemini/, so per-call isolation requires
   * either Gemini-CLI's `--settings <path>` (not universal across versions)
   * or a strict mutex across the whole run() lifetime. We take the mutex
   * approach — Gemini subprocess runs are slow (seconds-to-minutes) and the
   * operator-driven concurrency level is already low, so the throughput
   * cost is acceptable for cross-version correctness.
   */
  private static settingsMutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly binary: string,
    private readonly log: (msg: string) => void,
    private readonly bridgeMcp?: () =>
      | { url: string; authToken: string }
      | undefined,
  ) {}

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    // Resolve bridgeMcp ONCE per run() and pass the result down. The
    // closure may be cheap today, but calling it twice (once at the lock
    // gate, once inside _runLocked) opens a TOCTOU window: if the value
    // ever flips falsy→truthy between the two calls, the gate skips the
    // mutex but _runLocked writes settings.json without a lock.
    const mcp = this.bridgeMcp?.();
    if (mcp) {
      // If we're going to mutate ~/.gemini/settings.json, wait for any prior
      // Gemini run holding the same file to finish first.
      const prior = GeminiSubprocessDriver.settingsMutex;
      let releaseLock!: () => void;
      const ourLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      GeminiSubprocessDriver.settingsMutex = ourLock;
      try {
        await prior;
        return await this._runLocked(input, mcp);
      } finally {
        releaseLock();
      }
    }
    // No mcp injection → no settings file write → no mutex needed.
    return this._runLocked(input, undefined);
  }

  private async _runLocked(
    input: ProviderTaskInput,
    mcp: { url: string; authToken: string } | undefined,
  ): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};
    const approvalMode =
      typeof opts.approvalMode === "string" ? opts.approvalMode : "yolo";

    // Inject bridge MCP into ~/.gemini/settings.json before spawning so the
    // subprocess can call bridge tools. Gemini CLI reads settings.json at
    // startup. We snapshot whatever was there before (or remember "absent")
    // and restore it in a finally block at the end of run() — the bearer
    // token must NOT outlive this single invocation in a shared-home file.
    //
    // URL is rewritten to 127.0.0.1:<port> for the spawned subprocess: the
    // bridge may be bound 0.0.0.0 with a public --issuer-url, but the local
    // child should always dial loopback so neither the URL nor the token
    // ever leave this machine.
    let settingsCleanup: (() => void) | null = null;
    if (mcp) {
      const settingsFile = join(homedir(), ".gemini", "settings.json");
      try {
        let originalContent: string | null = null;
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsFile)) {
          originalContent = readFileSync(settingsFile, "utf-8");
          settings = JSON.parse(originalContent) as Record<string, unknown>;
        }
        const mcpServers = (settings.mcpServers ?? {}) as Record<
          string,
          unknown
        >;
        const previousBridgeEntry = Object.hasOwn(
          mcpServers,
          "claude-ide-bridge",
        )
          ? mcpServers["claude-ide-bridge"]
          : undefined;
        const localUrl = (() => {
          try {
            const u = new URL(mcp.url);
            // Force loopback — keeps token off the wire even if bridge bound 0.0.0.0
            u.hostname = "127.0.0.1";
            return u.toString();
          } catch {
            return mcp.url;
          }
        })();
        mcpServers["claude-ide-bridge"] = {
          url: localUrl,
          headers: { Authorization: `Bearer ${mcp.authToken}` },
        };
        settings.mcpServers = mcpServers;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), {
          mode: 0o600,
        });
        chmodSync(settingsFile, 0o600);
        // Schedule restoration. If the original file existed, write back its
        // exact bytes; if the bridge entry was absent, remove the key. If the
        // file did not exist before, delete it. Best-effort; logged on failure.
        settingsCleanup = () => {
          try {
            if (originalContent === null) {
              // File was created by us — try to remove. Tolerate ENOENT.
              try {
                unlinkSync(settingsFile);
              } catch {
                /* ignore */
              }
              return;
            }
            const parsed = JSON.parse(originalContent) as Record<
              string,
              unknown
            >;
            if (previousBridgeEntry === undefined) {
              const restoredServers = (parsed.mcpServers ?? {}) as Record<
                string,
                unknown
              >;
              if (Object.hasOwn(restoredServers, "claude-ide-bridge")) {
                delete restoredServers["claude-ide-bridge"];
              }
              parsed.mcpServers = restoredServers;
            }
            writeFileSync(settingsFile, JSON.stringify(parsed, null, 2), {
              mode: 0o600,
            });
            chmodSync(settingsFile, 0o600);
          } catch (err) {
            this.log(
              `[GeminiSubprocessDriver] WARN: could not restore ~/.gemini/settings.json: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };
      } catch (err) {
        this.log(
          `[GeminiSubprocessDriver] WARN: could not update ~/.gemini/settings.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      const args = [
        "-p",
        input.prompt,
        "--output-format",
        "stream-json",
        "--approval-mode",
        approvalMode,
      ];
      if (input.model) args.push("-m", input.model);
      // contextFiles: pass as --include-directories; normalize relative paths against workspace
      for (const f of input.contextFiles ?? []) {
        if (typeof f === "string" && f.length > 0 && !f.startsWith("-")) {
          const abs = isAbsolute(f) ? f : resolve(input.workspace, f);
          args.push("--include-directories", abs);
        }
      }

      // Strip MCP_* and CLAUDECODE vars; preserve GEMINI_API_KEY + GOOGLE_* vars
      const env = sanitizeEnv(process.env);
      // Also strip Claude-specific auth vars that could confuse Gemini
      for (const key of Object.keys(env)) {
        if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_API_KEY") {
          delete env[key];
        }
      }

      // On Windows, npm-installed gemini is a `.cmd` shim that spawn(shell:false)
      // can't launch by bare name (Node only auto-resolves `.exe` via PATHEXT).
      // Same fix that PR #525 applied to the Claude subprocess driver.
      const spawnBinary = ensureCmdShim(this.binary);

      this.log(
        `[GeminiSubprocessDriver] spawning: ${spawnBinary} -p <prompt> (workspace: ${input.workspace})`,
      );

      const child = spawn(spawnBinary, args, {
        cwd: homedir(),
        env,
        signal: input.signal,
        // Audit 2026-06-03 MEDIUM #13: detached:true makes the child a
        // process-group leader (setsid on POSIX) so treeKill can send
        // process.kill(-pid, signal) to kill the entire subtree. Without it,
        // process.kill(-pid) throws ESRCH (not a group leader) and grandchild
        // tool-processes spawned by Gemini are orphaned on abort/cancel.
        // Mirrors the Claude subprocess driver (src/drivers/claude/subprocess.ts).
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // unref() so the bridge can exit without waiting for the subprocess.
      child.unref();
      // Tree-kill on abort: kills the immediate child AND its descendants.
      // On Windows: taskkill /F /T /PID. On POSIX: process.kill(-pid, signal)
      // (works because detached:true makes the child a process-group leader).
      const onAbort = () => treeKill(child);
      input.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        input.signal.removeEventListener("abort", onAbort);
      });

      let lineBuf = "";
      let accumulated = "";
      let outputBytesSent = 0;
      let firstAssistantAt: number | undefined;
      let doneFromResult = false;
      let resultSuccess = true;

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        const { lines, remainder } = splitLines(lineBuf, chunk);
        lineBuf = remainder;

        for (const line of lines) {
          if (line.trim() === "") continue;
          let event: GeminiEvent;
          try {
            event = JSON.parse(line) as GeminiEvent;
          } catch {
            // Non-JSON stderr/warning lines — skip (Gemini prints "YOLO mode..." to stdout)
            continue;
          }

          if (
            event.type === "message" &&
            event.role === "assistant" &&
            event.content
          ) {
            if (firstAssistantAt === undefined) firstAssistantAt = Date.now();
            const text = event.content;
            accumulated += text;
            if (outputBytesSent < OUTPUT_CAP) {
              // Audit 2026-06-03 (#57): count UTF-8 BYTES, not UTF-16 units, so
              // the cap is honored for multi-byte output and chunks never split
              // a codepoint.
              const { send, bytes } = truncateToBytes(
                text,
                OUTPUT_CAP - outputBytesSent,
              );
              if (send.length > 0) {
                input.onChunk?.(send);
                outputBytesSent += bytes;
              }
            }
          } else if (event.type === "result") {
            doneFromResult = true;
            resultSuccess = event.status === "success";
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
        const isAbort =
          (err instanceof Error && err.name === "AbortError") ||
          input.signal.aborted;
        if (isAbort) {
          return {
            text: truncateUtf8Bytes(accumulated, OUTPUT_CAP),
            durationMs: Date.now() - start,
            wasAborted: true,
            startupMs: startupMsOf(),
            stderrTail: stderrTailOf(stderr),
          };
        }
        throw err;
      }
      if (startupHandle) clearTimeout(startupHandle);

      // Flush any partial line remaining in lineBuf after stdout closes.
      // splitLines() leaves content without a trailing '\n' in the remainder;
      // when the subprocess exits without a final newline the last JSON event
      // (e.g. the last assistant message) is silently dropped. Process it now.
      if (lineBuf.trim().length > 0) {
        let event: GeminiEvent;
        try {
          event = JSON.parse(lineBuf) as GeminiEvent;
          if (
            event.type === "message" &&
            event.role === "assistant" &&
            event.content
          ) {
            if (firstAssistantAt === undefined) firstAssistantAt = Date.now();
            const text = event.content;
            accumulated += text;
            if (outputBytesSent < OUTPUT_CAP) {
              const { send, bytes } = truncateToBytes(
                text,
                OUTPUT_CAP - outputBytesSent,
              );
              if (send.length > 0) {
                input.onChunk?.(send);
                outputBytesSent += bytes;
              }
            }
          } else if (event.type === "result") {
            doneFromResult = true;
            resultSuccess = event.status === "success";
          }
        } catch {
          // Non-JSON remainder — ignore (same as the data handler)
        }
        lineBuf = "";
      }

      if (startupTimedOut) {
        return {
          text: truncateUtf8Bytes(accumulated, OUTPUT_CAP),
          durationMs: Date.now() - start,
          wasAborted: true,
          startupTimedOut: true,
          stderrTail: stderrTailOf(stderr),
        };
      }

      const effectiveExitCode = doneFromResult
        ? resultSuccess
          ? 0
          : 1
        : exitCode;
      if (effectiveExitCode !== 0 && stderr) {
        this.log(`[GeminiSubprocessDriver] stderr: ${stderr.slice(0, 500)}`);
      }

      return {
        text: truncateUtf8Bytes(accumulated, OUTPUT_CAP),
        exitCode: effectiveExitCode,
        durationMs: Date.now() - start,
        stderrTail: stderrTailOf(stderr),
        startupMs: startupMsOf(),
      };
    } finally {
      // Always restore ~/.gemini/settings.json — bridge bearer token must
      // not survive in this shared-home file past one invocation.
      settingsCleanup?.();
    }
  }

  async runOutcome(input: ProviderTaskInput) {
    return toProviderTaskOutcome(await this.run(input));
  }
}
