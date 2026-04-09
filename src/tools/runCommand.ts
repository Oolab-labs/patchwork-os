import type { Config } from "../config.js";
import { INTERPRETER_COMMANDS } from "../config.js";
import {
  execSafe,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  successStructuredLarge,
  truncateOutput,
} from "./utils.js";

const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 16_384;

/** Flags that allow interpreter commands to execute arbitrary code */
const DANGEROUS_INTERPRETER_FLAGS = new Set([
  "-e",
  "--eval",
  "-c",
  "--print",
  "-p",
  "--input-type",
  "--import", // Node.js ESM loader
  "--loader", // Custom ESM loader
  "--experimental-loader", // Custom ESM loader (legacy)
  "-m", // Python module execution
  "--inspect", // Node.js debugger — opens a remote debug port
  "--inspect-brk", // Node.js debugger (break on start)
  "--inspect-port", // Node.js debugger port override
]);

/** Flags that redirect where commands read config/manifests from */
const DANGEROUS_PATH_FLAGS = new Set([
  "--prefix",
  "--manifest-path",
  "--config",
  "--rcfile",
  "--require",
  "--userconfig", // npm config redirection
  "--globalconfig", // npm config redirection
  "--makefile", // make Makefile path
  // curl output flags — would allow writing files to arbitrary paths
  "-o",
  "--output",
  "-O",
  "--remote-name",
  "-D",
  "--dump-header",
  "-K",
  // --config already in list above (covers curl -K alias too)
  // curl socket/proxy flags — would bypass SSRF hostname checks
  "--unix-socket",
  "--abstract-unix-socket",
  // curl credential file — arbitrary path read
  "--netrc-file",
]);

/**
 * Per-command blocklist additions — short flags that are dangerous only for
 * specific commands. Using a per-command approach avoids false positives on
 * common short flags (-f, -r) that have harmless meanings in most tools.
 */
const DANGEROUS_FLAGS_FOR_COMMAND: Record<string, Set<string>> = {
  // make -f <path> / --file <path> redirects which Makefile is executed
  make: new Set(["-f", "--file"]),
  // curl -w / --write-out can write to files via %output{/path} (curl 8.3+)
  // Scoped to curl only — -w has harmless meanings in many other tools
  curl: new Set(["-w", "--write-out"]),
  // node/ts-node -r <module> pre-requires arbitrary code
  node: new Set(["-r"]),
  "ts-node": new Set(["-r"]),
  tsx: new Set(["-r"]),
};

/**
 * Per-command exemptions from DANGEROUS_PATH_FLAGS.
 * Some commands use flag names that collide with the blocklist but have
 * harmless semantics (e.g. psql --config selects a libpq service entry,
 * not an arbitrary file to execute).
 */
const PATH_FLAG_EXEMPTIONS: Record<string, Set<string>> = {
  psql: new Set(["--config"]),
  pg_dump: new Set(["--config"]),
  pg_restore: new Set(["--config"]),
};

function validateCommand(command: string, allowlist: string[]): void {
  if (
    command.includes("/") ||
    command.includes("\\") ||
    command.includes("..") ||
    command.includes(" ")
  ) {
    throw new Error(
      `Invalid command "${command}": must be a simple basename without /, \\, .., or spaces`,
    );
  }
  if (!allowlist.some((entry) => entry.toLowerCase() === command)) {
    throw new Error(
      `Command "${command}" is not in the allowlist. Use --allow-command ${command} to add it. Run getToolCapabilities to see allowed commands.`,
    );
  }
}

function validateArgs(args: unknown, command: string): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    throw new Error("args must be an array of strings");
  }
  if (args.length > MAX_ARGS) {
    throw new Error(`args exceeds maximum length of ${MAX_ARGS}`);
  }
  const isInterpreter = INTERPRETER_COMMANDS.has(command);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") {
      throw new Error(`args[${i}] must be a string`);
    }
    if (arg.length > MAX_ARG_LENGTH) {
      throw new Error(`args[${i}] exceeds maximum length of ${MAX_ARG_LENGTH}`);
    }
    // Strip --flag=value → --flag so equals-sign form is caught by the blocklist.
    // e.g. "--eval=code" → "--eval", "--config=path" → "--config"
    const flag = arg.split("=")[0] ?? arg;
    // Block code-execution flags for interpreter commands
    if (isInterpreter && DANGEROUS_INTERPRETER_FLAGS.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked for interpreter command "${command}" — it allows arbitrary code execution`,
      );
    }
    // Block config/path-override flags for all commands (unless exempted)
    const exemptions = PATH_FLAG_EXEMPTIONS[command];
    if (DANGEROUS_PATH_FLAGS.has(flag) && !exemptions?.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked — it can redirect command execution outside the workspace`,
      );
    }
    // Block per-command dangerous short flags (e.g. make -f, node -r)
    if (DANGEROUS_FLAGS_FOR_COMMAND[command]?.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked for command "${command}" — it can redirect command execution outside the workspace`,
      );
    }
  }
  return args as string[];
}

export function createRunCommandTool(workspace: string, config: Config) {
  return {
    schema: {
      name: "runCommand",
      description:
        "Execute an allowlisted command in the workspace. Returns stdout, stderr, exit code, and timing information. Commands run without a shell for security.",
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          command: {
            type: "string",
            description:
              "Command basename to run (must be in the allowlist, no paths)",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command (absolute or workspace-relative, default: workspace root)",
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
        },
        required: ["exitCode", "stdout", "stderr", "durationMs", "timedOut"],
      },
    },
    timeoutMs: 300_000,
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      // Normalize to lowercase before all validation — prevents case-sensitivity bypass
      // on case-insensitive filesystems (macOS HFS+, Windows) where "NODE" resolves to "node"
      const command = requireString(args, "command", 256).toLowerCase();
      validateCommand(command, config.commandAllowlist);

      const cmdArgs = validateArgs(args.args, command);
      const cwdRaw = optionalString(args, "cwd");
      const timeout =
        optionalInt(args, "timeout", 1000, 600_000) ?? config.commandTimeout;

      const cwd = cwdRaw ? resolveFilePath(cwdRaw, workspace) : workspace;

      const maxBytes = config.maxResultSize * 1024;

      const result = await execSafe(command, cmdArgs, {
        cwd,
        timeout,
        maxBuffer: maxBytes,
        signal,
      });

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
