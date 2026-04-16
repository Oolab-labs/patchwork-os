/**
 * Pure command-description builder extracted from runCommand.ts.
 * All allowlist/blocklist/path-traversal security checks live here.
 * No side effects, no fs.*, no process.* (except INTERPRETER_COMMANDS import).
 */
import { INTERPRETER_COMMANDS } from "../config.js";
import {
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
} from "../tools/utils.js";

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
  "--import",
  "--loader",
  "--experimental-loader",
  "-m",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
]);

/** Flags that redirect where commands read config/manifests from */
const DANGEROUS_PATH_FLAGS = new Set([
  "--prefix",
  "--manifest-path",
  "--config",
  "--rcfile",
  "--require",
  "--userconfig",
  "--globalconfig",
  "--makefile",
  "-o",
  "--output",
  "-O",
  "--remote-name",
  "-D",
  "--dump-header",
  "-K",
  "--unix-socket",
  "--abstract-unix-socket",
  "--netrc-file",
]);

const DANGEROUS_FLAGS_FOR_COMMAND: Record<string, Set<string>> = {
  make: new Set(["-f", "--file"]),
  curl: new Set(["-w", "--write-out"]),
  node: new Set(["-r"]),
  "ts-node": new Set(["-r"]),
  tsx: new Set(["-r"]),
};

const PATH_FLAG_EXEMPTIONS: Record<string, Set<string>> = {
  psql: new Set(["--config"]),
  pg_dump: new Set(["--config"]),
  pg_restore: new Set(["--config"]),
};

export interface CommandDescription {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeout: number;
  readonly maxBuffer: number;
}

export interface CommandConfig {
  commandAllowlist: string[];
  commandTimeout: number;
  maxResultSize: number; // in KB
}

function validateCommandName(command: string, allowlist: string[]): void {
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

function validateCommandArgs(
  args: unknown,
  command: string,
  workspace: string,
): string[] {
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
    const flag = arg.split("=")[0] ?? arg;
    if (isInterpreter && DANGEROUS_INTERPRETER_FLAGS.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked for interpreter command "${command}" — it allows arbitrary code execution`,
      );
    }
    const exemptions = PATH_FLAG_EXEMPTIONS[command];
    if (DANGEROUS_PATH_FLAGS.has(flag) && !exemptions?.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked — it can redirect command execution outside the workspace`,
      );
    }
    if (DANGEROUS_FLAGS_FOR_COMMAND[command]?.has(flag)) {
      throw new Error(
        `Flag "${flag}" is blocked for command "${command}" — it can redirect command execution outside the workspace`,
      );
    }
    if (!arg.startsWith("-") && (arg.startsWith("/") || arg.startsWith("~/"))) {
      try {
        resolveFilePath(arg, workspace);
      } catch {
        throw new Error(
          `args[${i}] "${arg}" is an absolute path outside the workspace`,
        );
      }
    }
  }
  return args as string[];
}

/**
 * Validate raw tool arguments and return an immutable command description.
 * Throws on any security violation (allowlist, blocklist, path-traversal).
 * All security checks are performed here — executeCommand receives a trusted descriptor.
 */
export function buildCommandDescription(
  rawArgs: Record<string, unknown>,
  config: CommandConfig,
  workspace: string,
): CommandDescription {
  const command = requireString(rawArgs, "command", 256).toLowerCase();
  validateCommandName(command, config.commandAllowlist);
  const args = validateCommandArgs(rawArgs.args, command, workspace);
  const cwdRaw = optionalString(rawArgs, "cwd");
  const timeout =
    optionalInt(rawArgs, "timeout", 1000, 600_000) ?? config.commandTimeout;
  const cwd = cwdRaw ? resolveFilePath(cwdRaw, workspace) : workspace;
  const maxBuffer = config.maxResultSize * 1024;
  return { command, args, cwd, timeout, maxBuffer };
}
