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

/**
 * Destructive shell-command patterns blocked for every Gemini subprocess run
 * (drivers-orch-6). GeminiSubprocessDriver spawns with `--approval-mode yolo`,
 * which disables all interactive approval prompts; without a deny list the
 * spawned agent can run arbitrary destructive shell commands. Mirrors the
 * Claude subprocess DENY_LIST (src/drivers/claude/subprocessSettings.ts).
 *
 * Gemini CLI excludes command-scoped shell invocations via the
 * `run_shell_command(<prefix>)` syntax. We write the same list under both
 * `tools.exclude` (current schema) and top-level `excludeTools` (legacy
 * schema) so the deny list takes effect across CLI versions.
 */
const GEMINI_SHELL_DENY_PATTERNS = [
  // Filesystem destruction (all flag orderings Claude Code/Gemini match literally)
  "run_shell_command(rm -rf)",
  "run_shell_command(rm -fr)",
  "run_shell_command(rm -r)",
  "run_shell_command(rm --recursive)",
  // Git history / remote destruction
  "run_shell_command(git push)",
  "run_shell_command(git reset --hard)",
  "run_shell_command(git clean -f)",
  "run_shell_command(git clean -d)",
  "run_shell_command(git clean --force)",
  // Publishing / release
  "run_shell_command(npm publish)",
  "run_shell_command(npm version)",
  // Privilege escalation
  "run_shell_command(sudo)",
  "run_shell_command(chmod 777)",
  // Process termination
  "run_shell_command(kill -9)",
  "run_shell_command(pkill)",
];

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
    // _runLocked ALWAYS mutates ~/.gemini/settings.json now — to inject the
    // destructive-command deny list (drivers-orch-6) even when no MCP is
    // injected — so EVERY run must hold the settings mutex, not just MCP runs.
    // Wait for any prior Gemini run holding the same file to finish first.
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

  private async _runLocked(
    input: ProviderTaskInput,
    mcp: { url: string; authToken: string } | undefined,
  ): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};
    const approvalMode =
      typeof opts.approvalMode === "string" ? opts.approvalMode : "yolo";

    // Mutate ~/.gemini/settings.json before spawning so the subprocess (1) can
    // call bridge tools when MCP is injected and (2) ALWAYS runs with a
    // destructive-command deny list (drivers-orch-6). Gemini CLI reads
    // settings.json at startup. We snapshot whatever was there before (or
    // remember "absent") and restore it in a finally block at the end of run()
    // — the deny list and the bearer token must NOT outlive this single
    // invocation in a shared-home file.
    //
    // URL is rewritten to 127.0.0.1:<port> for the spawned subprocess: the
    // bridge may be bound 0.0.0.0 with a public --issuer-url, but the local
    // child should always dial loopback so neither the URL nor the token
    // ever leave this machine.
    //
    // This block runs on EVERY run (not only when mcp is present) so the deny
    // list is applied even for non-MCP tasks running under --approval-mode yolo.
    let settingsCleanup: (() => void) | null = null;
    {
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
        if (mcp) {
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
        }
        // Apply the destructive-command deny list. Written under both the
        // current (`tools.exclude`) and legacy (`excludeTools`) keys so the
        // restriction is honored across Gemini CLI versions. Merge with any
        // pre-existing excludes so operator-configured denials are preserved.
        const existingTools = (settings.tools ?? {}) as Record<string, unknown>;
        const existingToolsExclude = Array.isArray(existingTools.exclude)
          ? (existingTools.exclude as unknown[]).filter(
              (e): e is string => typeof e === "string",
            )
          : [];
        settings.tools = {
          ...existingTools,
          exclude: Array.from(
            new Set([...existingToolsExclude, ...GEMINI_SHELL_DENY_PATTERNS]),
          ),
        };
        const existingExcludeTools = Array.isArray(settings.excludeTools)
          ? (settings.excludeTools as unknown[]).filter(
              (e): e is string => typeof e === "string",
            )
          : [];
        settings.excludeTools = Array.from(
          new Set([...existingExcludeTools, ...GEMINI_SHELL_DENY_PATTERNS]),
        );
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
            if (previousBridgeEntry === undefined) {
              // The bridge key did not exist before we ran — restore the
              // original bytes verbatim. Re-parsing and re-stringifying would
              // normalise formatting and drop any unknown top-level keys or
              // non-standard whitespace present in the original file.
              writeFileSync(settingsFile, originalContent, {
                encoding: "utf-8",
                mode: 0o600,
              });
            } else {
              // The bridge key existed before — restore our previous value
              // inside the parsed structure so other keys are preserved.
              const parsed = JSON.parse(originalContent) as Record<
                string,
                unknown
              >;
              const restoredServers = (parsed.mcpServers ?? {}) as Record<
                string,
                unknown
              >;
              restoredServers["claude-ide-bridge"] = previousBridgeEntry;
              parsed.mcpServers = restoredServers;
              writeFileSync(settingsFile, JSON.stringify(parsed, null, 2), {
                mode: 0o600,
              });
            }
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
      // Audit 2026-06-08 (drivers-5): cap stderr by BYTES, not string length.
      // setEncoding("utf-8") yields string chunks, so `.length`/`.slice` counted
      // UTF-16 units and let multi-byte stderr exceed OUTPUT_CAP (and split a
      // surrogate pair on slice). truncateUtf8Bytes cuts on a byte boundary.
      let stderrBytes = 0;
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        if (stderrBytes < OUTPUT_CAP) {
          stderr += chunk;
          stderrBytes += Buffer.byteLength(chunk, "utf-8");
          if (stderrBytes > OUTPUT_CAP) {
            stderr = truncateUtf8Bytes(stderr, OUTPUT_CAP);
            stderrBytes = OUTPUT_CAP;
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
