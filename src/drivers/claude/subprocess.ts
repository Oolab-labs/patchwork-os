import { spawn } from "node:child_process";
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
 * Claude-specific providerOptions: { effort, fallbackModel, maxBudgetUsd, useAnt }
 */
export class SubprocessDriver implements ProviderDriver {
  readonly name = "subprocess";
  private readonly settings: ReturnType<typeof createSubprocessSettings>;

  constructor(
    private readonly binary: string,
    private readonly antBinary: string,
    private readonly log: (msg: string) => void,
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

    const effectiveBinary = useAnt ? this.antBinary : this.binary;
    // Re-write before each run — /tmp may be cleared on long-running servers.
    this.settings.write();

    const args = [
      "-p",
      input.prompt,
      "--strict-mcp-config",
      "--settings",
      this.settings.path,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
    ];
    if (input.model) args.push("--model", input.model);
    if (effort) args.push("--effort", effort);
    if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
    if (fallbackModel) args.push("--fallback-model", fallbackModel);
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
