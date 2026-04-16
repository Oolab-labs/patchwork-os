import type { Config } from "../config.js";
import { buildCommandDescription } from "../fp/commandDescription.js";
import {
  execSafe,
  execSafeStreaming,
  successStructuredLarge,
  truncateOutput,
  withHeartbeat,
} from "./utils.js";

export function createRunCommandTool(workspace: string, config: Config) {
  return {
    schema: {
      name: "runCommand",
      description:
        "Execute allowlisted command. Returns stdout, stderr, exit code, timing. No shell for security.",
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          command: {
            type: "string",
            description: "Command basename (must be in allowlist, no paths)",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments",
          },
          cwd: {
            type: "string",
            description:
              "Working dir (absolute or workspace-relative, default: workspace root)",
          },
          timeout: {
            type: "integer",
            description: `Timeout in milliseconds (default: ${config.commandTimeout}, max: 600000)`,
          },
        },
        required: ["command"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          exitCode: { type: "integer" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          durationMs: { type: "number" },
          timedOut: { type: "boolean" },
          truncated: { type: "boolean" },
          stdoutTruncated: { type: "boolean" },
          stderrTruncated: { type: "boolean" },
          maxBytes: { type: "number" },
          note: { type: "string" },
        },
        required: ["exitCode", "stdout", "stderr", "durationMs", "timedOut"],
      },
    },
    timeoutMs: 300_000,
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: (value: number, total?: number, message?: string) => void,
    ) => {
      const desc = buildCommandDescription(
        args,
        {
          commandAllowlist: config.commandAllowlist,
          commandTimeout: config.commandTimeout,
          maxResultSize: config.maxResultSize,
        },
        workspace,
      );

      const {
        command,
        args: cmdArgs,
        cwd,
        timeout,
        maxBuffer: maxBytes,
      } = desc;

      // When caller provides a progressToken, stream each stdout line as a
      // progress notification so the user sees live output.
      // Without progressToken fall back to periodic heartbeat (no behavior change).
      let lineCount = 0;
      const result = progress
        ? await execSafeStreaming(command, cmdArgs as string[], {
            cwd,
            timeout,
            maxBuffer: maxBytes,
            signal,
            onLine: (line) => {
              lineCount++;
              progress(lineCount, undefined, line);
            },
          })
        : await withHeartbeat(
            () =>
              execSafe(command, cmdArgs as string[], {
                cwd,
                timeout,
                maxBuffer: maxBytes,
                signal,
              }),
            progress,
            { message: `running ${command}…`, intervalMs: 5_000 },
          );

      const stdoutResult = truncateOutput(result.stdout, maxBytes);
      const stderrResult = truncateOutput(result.stderr, maxBytes);
      const anyTruncated = stdoutResult.truncated || stderrResult.truncated;

      return successStructuredLarge({
        exitCode: result.exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        ...(anyTruncated
          ? {
              truncated: true,
              stdoutTruncated: stdoutResult.truncated,
              stderrTruncated: stderrResult.truncated,
              maxBytes,
              note: "Output exceeded limit. Redirect to a file (command > out.txt) to capture full output.",
            }
          : {}),
      });
    },
  };
}
