import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sanitizeEnv } from "../claude/envSanitizer.js";
import { splitLines } from "../claude/streamParser.js";
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

  constructor(
    private readonly binary: string,
    private readonly log: (msg: string) => void,
    private readonly bridgeMcp?: () =>
      | { url: string; authToken: string }
      | undefined,
  ) {}

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};
    const approvalMode =
      typeof opts.approvalMode === "string" ? opts.approvalMode : "yolo";

    // Inject bridge MCP into ~/.gemini/settings.json before spawning so the
    // subprocess can call bridge tools. Gemini CLI reads settings.json at startup.
    const mcp = this.bridgeMcp?.();
    if (mcp) {
      const settingsFile = join(homedir(), ".gemini", "settings.json");
      try {
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsFile)) {
          settings = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<
            string,
            unknown
          >;
        }
        const mcpServers = (settings.mcpServers ?? {}) as Record<
          string,
          unknown
        >;
        mcpServers["claude-ide-bridge"] = {
          url: mcp.url,
          headers: { Authorization: `Bearer ${mcp.authToken}` },
        };
        settings.mcpServers = mcpServers;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), {
          mode: 0o600,
        });
        chmodSync(settingsFile, 0o600);
      } catch (err) {
        this.log(
          `[GeminiSubprocessDriver] WARN: could not update ~/.gemini/settings.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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

    this.log(
      `[GeminiSubprocessDriver] spawning: ${this.binary} -p <prompt> (workspace: ${input.workspace})`,
    );

    const child = spawn(this.binary, args, {
      cwd: homedir(),
      env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.unref();

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
            const send = text.slice(0, OUTPUT_CAP - outputBytesSent);
            if (send.length > 0) {
              input.onChunk?.(send);
              outputBytesSent += send.length;
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
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        input.signal.aborted;
      if (isAbort) {
        return {
          text: accumulated.slice(0, OUTPUT_CAP),
          durationMs: Date.now() - start,
          wasAborted: true,
          startupMs: startupMsOf(),
          stderrTail: stderrTailOf(stderr),
        };
      }
      throw err;
    }
    if (startupHandle) clearTimeout(startupHandle);

    if (startupTimedOut) {
      return {
        text: accumulated.slice(0, OUTPUT_CAP),
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
      text: accumulated.slice(0, OUTPUT_CAP),
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
