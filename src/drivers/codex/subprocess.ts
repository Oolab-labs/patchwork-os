import { spawn } from "node:child_process";
import { treeKill } from "../../processTree.js";
import { ensureCmdShim } from "../../winShim.js";
import { sanitizeEnv } from "../claude/envSanitizer.js";
import { truncateToBytes, truncateUtf8Bytes } from "../outputCap.js";
import type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";
import { toProviderTaskOutcome } from "../types.js";
import { parseStreamLine, splitLines } from "./streamParser.js";

const OUTPUT_CAP = 50 * 1024; // 50KB — matches the Claude subprocess driver's cap

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalMode = "untrusted" | "on-request" | "never";

/**
 * Scrub secrets from a string before storing or surfacing it. Same patterns
 * as the Claude driver's scrubSecrets, plus an OpenAI-shaped API key pattern
 * (sk-proj-.../sk-...) in case a user has OPENAI_API_KEY-based auth rather
 * than the default ChatGPT-subscription login.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-(proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\btoken[=:]\s*[A-Za-z0-9._-]{16,}/gi, "token=[REDACTED]");
}

/**
 * Codex subprocess driver — spawns `codex exec` with ChatGPT-subscription
 * auth (whatever `codex login` already established; no API key handling
 * here, mirroring how the Claude subprocess driver relies on `claude`'s own
 * stored subscription auth rather than passing a credential itself).
 *
 * FAIL-CLOSED BY DEFAULT — this is a deliberate divergence from the Claude
 * subprocess driver, whose default (no sandbox opt-in) is
 * `--dangerously-skip-permissions` (fail-OPEN: full native tool access).
 * Codex CLI's own non-interactive docs explicitly warn that `codex exec`
 * does NOT default to something safe for unattended callers — every
 * restrictive flag below is passed unconditionally unless a caller
 * explicitly escalates via providerOptions:
 *
 *   sandboxMode:    "read-only" (default) | "workspace-write" | "danger-full-access"
 *   approvalMode:   "never" (default) | "on-request" | "untrusted"
 *   networkAccess:  false (default) — passed as `-c sandbox.network_access=false`
 *   webSearch:      false (default) — omitting --search leaves Codex's own
 *                   default ("cached"); NOT the same as fully disabled, but
 *                   there is no documented flag to disable it outright as of
 *                   this writing. Flagged here rather than silently assumed.
 *
 * Codex CLI's own cancellation has confirmed upstream bugs (orphaned MCP
 * stdio subprocesses, shell-wrapper children surviving interrupt — see
 * openai/codex issues #4337, #7985, #12491, #15379, #20869) — treeKill
 * (process-group kill, not a direct-child-only kill()) is used from the
 * start, not added later.
 */
export class CodexDriver implements ProviderDriver {
  readonly name = "codex";

  constructor(
    private readonly binary: string,
    private readonly log: (msg: string) => void,
  ) {}

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    const opts = input.providerOptions ?? {};

    // Defense-in-depth: reject argv-confusable user-controlled strings.
    // Spawn is called with an array (no shell), so this is argv defense for
    // the child's flag parser, not shell-injection defense. Mirrors the
    // Claude driver's identical guard.
    if (input.prompt.startsWith("-")) {
      throw new Error(
        "[CodexDriver] prompt cannot start with '-' (argv injection guard)",
      );
    }

    const effectiveBinary = ensureCmdShim(this.binary);

    const sandboxMode: SandboxMode =
      opts.sandboxMode === "workspace-write" ||
      opts.sandboxMode === "danger-full-access"
        ? opts.sandboxMode
        : "read-only";
    const approvalMode: ApprovalMode =
      opts.approvalMode === "on-request" || opts.approvalMode === "untrusted"
        ? opts.approvalMode
        : "never";
    const networkAccess = opts.networkAccess === true;
    const webSearch = opts.webSearch === true;

    const args = [
      "exec",
      input.prompt,
      "--json",
      "--sandbox",
      sandboxMode,
      "--ask-for-approval",
      approvalMode,
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      `sandbox.network_access=${networkAccess ? "true" : "false"}`,
    ];
    if (webSearch) args.push("--search");

    // env sanitization: reuse the Claude driver's sanitizeEnv as-is (a
    // generic cross-provider-secret strip with no Claude-specific coupling —
    // see envSanitizer.ts's own doc comment). Codex's subscription auth
    // lives in codex's own config/auth file, not an env var, so no
    // `preserve` entry is needed for the default (subscription) auth path.
    const env = sanitizeEnv(process.env);

    this.log(
      `[CodexDriver] spawning: ${effectiveBinary} exec <prompt> (workspace: ${input.workspace}, sandbox: ${sandboxMode})`,
    );

    const child = spawn(effectiveBinary, args, {
      cwd: input.workspace,
      env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // setsid() — prevents subprocess from opening /dev/tty for interactive
      // prompts, and makes it its own process-group leader for treeKill.
      detached: true,
    });
    // Node's `signal` option calls `child.kill()` on abort, which only
    // signals the immediate child — insufficient given Codex's confirmed
    // upstream orphaned-child-process bugs (see class doc comment).
    const onAbort = () => treeKill(child);
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => {
      input.signal.removeEventListener("abort", onAbort);
    });

    let lineBuf = "";
    let accumulated = "";
    let outputBytesSent = 0;
    let firstAgentMessageAt: number | undefined;
    let sawError = false;
    let errorText = "";
    let resultUsage:
      | { input_tokens?: number; output_tokens?: number }
      | undefined;

    const emitText = (text: string) => {
      if (text.length === 0) return;
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
    };

    const handleLine = (line: string) => {
      if (line.trim() === "") return;
      const parsed = parseStreamLine(line);
      if (parsed.kind === "raw") {
        emitText(parsed.text);
        return;
      }
      const { event, text } = parsed;
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        if (firstAgentMessageAt === undefined) firstAgentMessageAt = Date.now();
        emitText(text);
      } else if (event.type === "turn.completed") {
        resultUsage = event.usage;
      } else if (event.type === "error" || event.type === "turn.failed") {
        sawError = true;
        errorText = text || errorText;
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const { lines, remainder } = splitLines(lineBuf, chunk);
      lineBuf = remainder;
      for (const line of lines) handleLine(line);
    });

    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
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
      firstAgentMessageAt !== undefined
        ? firstAgentMessageAt - start
        : undefined;

    let startupTimedOut = false;
    const startupHandle = input.startupTimeoutMs
      ? setTimeout(() => {
          if (firstAgentMessageAt === undefined) {
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

    // Flush any partial line remaining in lineBuf after stdout closes —
    // mirrors the Claude driver's identical flush-on-close handling.
    if (lineBuf.trim().length > 0) {
      handleLine(lineBuf);
      lineBuf = "";
    }

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

    const effectiveExitCode = sawError ? 1 : exitCode;
    if (effectiveExitCode !== 0 && stderr) {
      this.log(`[CodexDriver] stderr: ${stderr.slice(0, 500)}`);
    }

    const providerMeta: Record<string, unknown> = {};
    if (
      typeof resultUsage?.input_tokens === "number" &&
      typeof resultUsage?.output_tokens === "number"
    ) {
      providerMeta.inputTokens = resultUsage.input_tokens;
      providerMeta.outputTokens = resultUsage.output_tokens;
    }
    if (input.model && !input.model.startsWith("-")) {
      providerMeta.model = input.model;
    }

    return {
      text: truncateUtf8Bytes(
        sawError && accumulated.length === 0 ? errorText : accumulated,
        OUTPUT_CAP,
      ),
      exitCode: effectiveExitCode,
      errorMessage: sawError
        ? errorText || "codex exec reported an error"
        : undefined,
      durationMs: Date.now() - start,
      stderrTail: stderrTailOf(stderr),
      startupMs: startupMsOf(),
      providerMeta:
        Object.keys(providerMeta).length > 0 ? providerMeta : undefined,
    };
  }

  async runOutcome(input: ProviderTaskInput) {
    return toProviderTaskOutcome(await this.run(input));
  }
}
