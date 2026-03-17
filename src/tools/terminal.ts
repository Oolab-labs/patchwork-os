import { INTERPRETER_COMMANDS } from "../config.js";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

/**
 * Flags that allow interpreter commands to execute arbitrary code.
 * Mirrors DANGEROUS_INTERPRETER_FLAGS in runCommand.ts — applied here to
 * terminal commands where the shell is involved and quoting cannot be trusted.
 */
const TERMINAL_DANGEROUS_INTERPRETER_FLAGS = new Set([
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
  "--inspect", // Node.js debugger — opens a remote debug port
  "--inspect-brk", // Node.js debugger (break on start)
  "--inspect-port", // Node.js debugger port override
]);

/**
 * Flags that redirect where commands read config/manifests from.
 * Mirrors DANGEROUS_PATH_FLAGS in runCommand.ts.
 */
const TERMINAL_DANGEROUS_PATH_FLAGS = new Set([
  "--prefix",
  "--manifest-path",
  "--config",
  "--rcfile",
  "--require",
  "-r",
  "--userconfig",
  "--globalconfig",
  "-f",
  "--makefile",
]);

/** Environment variable names that could enable privilege escalation */
const DANGEROUS_ENV_VARS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "CLASSPATH",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "EDITOR",
  "VISUAL",
  "SHELL",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "NPM_CONFIG_SCRIPT_SHELL",
  "CARGO_HOME",
]);

/**
 * Validate terminal command tokens for dangerous flags.
 * Returns an error string if a dangerous flag is found, undefined otherwise.
 *
 * Terminal commands run inside a real shell, so flag-level argument injection
 * (e.g. `git -c core.pager=evil`) cannot be caught by the metacharacter filter.
 * We apply the same flag blocklists used by runCommand for interpreter and
 * config-redirect flags.
 */
function validateTerminalCommandFlags(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  const cmd = tokens[0]?.toLowerCase() ?? "";
  const isInterpreter = INTERPRETER_COMMANDS.has(cmd);

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // Strip value for flags like --config=value → --config
    const flag = tok.split("=")[0] ?? tok;
    if (isInterpreter && TERMINAL_DANGEROUS_INTERPRETER_FLAGS.has(flag)) {
      return `Flag "${flag}" is not allowed for interpreter command "${cmd}" (code execution risk)`;
    }
    if (TERMINAL_DANGEROUS_PATH_FLAGS.has(flag)) {
      return `Flag "${flag}" is not allowed in terminal commands (config redirect risk)`;
    }
  }
  return undefined;
}

/**
 * Validate a terminal command string against security rules.
 * Returns an error message if invalid, undefined if the command is safe.
 */
function validateCommand(
  text: string,
  commandAllowlist: string[],
): string | undefined {
  // Also block Unicode line/paragraph separators (\u2028, \u2029) which act
  // as line terminators in JavaScript and some shell contexts.
  if (/[\n\r\u2028\u2029]/.test(text)) {
    return "Command must not contain newlines. Send one command at a time.";
  }
  if (/[;&|`$()<>{}!\\~]/.test(text)) {
    return (
      "Command must not contain shell metacharacters (;&|`$()<>{}!\\~). " +
      "These could chain additional commands beyond the allowlist."
    );
  }
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstWord && !commandAllowlist.includes(firstWord)) {
    return (
      `Command "${firstWord}" is not in the allowlist. ` +
      `Allowed commands: ${commandAllowlist.join(", ")}. ` +
      `Use --allow-command ${firstWord} to add it.`
    );
  }
  return validateTerminalCommandFlags(text);
}

/** Apply prefix to a terminal name (no-op when prefix is empty).
 * When prefix is set and name is undefined, generates a unique prefixed default name
 * so the terminal remains discoverable by listTerminals for this session. */
function prefixName(
  name: string | undefined,
  prefix: string,
): string | undefined {
  if (!prefix) return name;
  if (name === undefined) {
    // Generate a unique default so unnamed terminals are still session-scoped
    return `${prefix}terminal-${Date.now().toString(36)}`;
  }
  return `${prefix}${name}`;
}

/** Strip prefix from a terminal name (no-op when prefix is empty). */
function stripPrefix(name: string, prefix: string): string {
  if (!prefix) return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** In multi-session mode, index-based terminal lookup is unsafe because the
 * global index does not correspond to the session-scoped index shown by listTerminals.
 * Returns an error string when this case is detected, or null if the call is safe. */
function checkIndexWithPrefix(
  name: string | undefined,
  index: number | undefined,
  prefix: string,
): string | null {
  if (prefix && name === undefined && index !== undefined) {
    return (
      "Terminal index-based lookup is not supported when multiple agent sessions are active. " +
      "Use terminal name instead (from listTerminals). " +
      "Index 0 in your session refers to a different global index than in VS Code."
    );
  }
  return null;
}

export function createListTerminalsTool(
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "listTerminals",
      extensionRequired: true,
      description:
        "List all active VS Code integrated terminals. Returns terminal names, indices, and whether output capture is available. Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
    handler: async () => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("terminal features");
      }
      try {
        const result = await extensionClient.listTerminals();
        if (result === null) {
          return success({ terminals: [] });
        }
        if (!terminalPrefix) {
          return success(result);
        }
        // Filter to this session's terminals and strip prefix from names
        const r = result as { terminals?: Array<{ name?: string }> };
        const filtered = {
          ...result,
          terminals: (r.terminals ?? [])
            .filter(
              (t) =>
                typeof t.name === "string" && t.name.startsWith(terminalPrefix),
            )
            .map((t) => ({
              ...t,
              name:
                typeof t.name === "string"
                  ? stripPrefix(t.name, terminalPrefix)
                  : t.name,
            })),
        };
        return success(filtered);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createGetTerminalOutputTool(
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "getTerminalOutput",
      extensionRequired: true,
      description:
        "Get recent output from a VS Code integrated terminal. Identify the terminal by name or index (from listTerminals). Returns the last N lines of output. Requires the VS Code extension with terminal output capture enabled.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Terminal name to retrieve output from",
          },
          index: {
            type: "integer" as const,
            description: "Terminal index (0-based) from listTerminals",
          },
          lines: {
            type: "integer" as const,
            description:
              "Number of recent lines to retrieve (default 100, max 5000)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("terminal output");
      }
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const lines = optionalInt(args, "lines", 1, 5000);
      if (name === undefined && index === undefined) {
        return error(
          "At least one of 'name' or 'index' must be provided to identify the terminal",
        );
      }
      const indexErr = checkIndexWithPrefix(name, index, terminalPrefix);
      if (indexErr) return error(indexErr);
      try {
        const result = await extensionClient.getTerminalOutput(
          prefixName(name, terminalPrefix),
          index,
          lines,
        );
        if (result === null) {
          return error("Terminal not found");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createCreateTerminalTool(
  workspace: string,
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "createTerminal",
      extensionRequired: true,
      description:
        "Create a new VS Code integrated terminal. Optionally set a name, working directory, environment variables, and shell. Requires the VS Code extension.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Display name for the terminal",
          },
          cwd: {
            type: "string" as const,
            description:
              "Working directory for the terminal (must be within workspace)",
          },
          env: {
            type: "object" as const,
            description:
              "Additional environment variables (key-value pairs, max 50 entries)",
            additionalProperties: { type: "string" as const },
          },
          show: {
            type: "boolean" as const,
            description:
              "Show the terminal panel after creation (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("createTerminal");
      }
      const name = optionalString(args, "name", 256);
      const rawCwd = optionalString(args, "cwd");
      const resolvedCwd = rawCwd
        ? resolveFilePath(rawCwd, workspace)
        : undefined;
      const rawEnv = args.env;
      let env: Record<string, string> | undefined;
      if (rawEnv !== undefined) {
        if (
          typeof rawEnv !== "object" ||
          rawEnv === null ||
          Array.isArray(rawEnv)
        ) {
          return error("'env' must be an object with string key-value pairs");
        }
        const keys = Object.keys(rawEnv as Record<string, unknown>);
        if (keys.length > 50) {
          return error("'env' must have at most 50 entries");
        }
        env = {};
        for (const [k, v] of Object.entries(
          rawEnv as Record<string, unknown>,
        )) {
          if (typeof v !== "string") {
            return error(`env["${k}"] must be a string`);
          }
          if (DANGEROUS_ENV_VARS.has(k.toUpperCase())) {
            return error(
              `Environment variable "${k}" is blocked for security — it can redirect command execution`,
            );
          }
          env[k] = v;
        }
      }
      const show = optionalBool(args, "show") ?? true;

      try {
        const result = await extensionClient.createTerminal(
          prefixName(name, terminalPrefix),
          resolvedCwd,
          env,
          show,
        );
        if (result === null) {
          return error("Failed to create terminal");
        }
        // Strip prefix from returned name so the agent sees its logical name
        const resultWithName = result as { name?: string };
        const stripped =
          terminalPrefix && resultWithName.name
            ? {
                ...result,
                name: stripPrefix(resultWithName.name, terminalPrefix),
              }
            : result;
        return success(stripped);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createWaitForTerminalOutputTool(
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "waitForTerminalOutput",
      extensionRequired: true,
      description:
        "Block until a regex pattern appears in a VS Code terminal's output, then return the matching line. " +
        "Use this after sendTerminalCommand to detect when a background process is ready " +
        "(e.g. wait for 'ready|listening|compiled' after starting a dev server). " +
        "Requires terminal output capture (VS Code proposed API). " +
        "Returns {matched, matchedLine, elapsed} on success or {matched: false, timedOut: true} on timeout.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["pattern"],
        properties: {
          pattern: {
            type: "string" as const,
            description:
              "JavaScript regex pattern to match against terminal output lines",
          },
          name: {
            type: "string" as const,
            description:
              "Terminal name to watch (from listTerminals). Uses active terminal if omitted.",
          },
          index: {
            type: "integer" as const,
            description:
              "Terminal index (0-based) from listTerminals. Used if name is not specified.",
          },
          timeout: {
            type: "integer" as const,
            description:
              "Seconds to wait before giving up (default: 30, max: 300)",
          },
        },
        additionalProperties: false as const,
      },
    },
    // Extension adds a 5 s internal buffer on top of the user timeout — raise
    // the tool ceiling by 10 s so the extension response always arrives before
    // the MCP transport cancels the request.
    timeoutMs: 310_000,
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("waitForTerminalOutput");
      }
      const pattern = requireString(args, "pattern", 1_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const timeoutSec = optionalInt(args, "timeout", 1, 300) ?? 30;
      const timeoutMs = timeoutSec * 1_000;
      const indexErr = checkIndexWithPrefix(name, index, terminalPrefix);
      if (indexErr) return error(indexErr);

      // Validate the regex on the bridge side to give a fast, clear error
      try {
        new RegExp(pattern);
      } catch (e) {
        return error(
          `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Reject patterns with nested quantifiers — these can cause catastrophic backtracking (ReDoS)
      // when tested repeatedly against terminal output lines over a long polling window.
      if (
        /\([^)]*[+*]\)[+*?]/.test(pattern) ||
        /\([^)]*\{[^}]+\}\)[+*{?]/.test(pattern) ||
        /[+*][+*]|\{[^}]+\}[+*]/.test(pattern)
      ) {
        return error(
          "Pattern contains nested quantifiers (e.g. (a+)+) which can cause catastrophic backtracking. " +
            "Simplify the regex — use a literal string match or a non-nested quantifier.",
        );
      }

      try {
        const result = await extensionClient.waitForTerminalOutput(
          pattern,
          prefixName(name, terminalPrefix),
          index,
          timeoutMs,
        );
        if (result === null) {
          return error(
            "Extension did not respond — ensure the VS Code extension is running",
          );
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension connection timed out waiting for terminal output",
          );
        }
        throw err;
      }
    },
  };
}

export function createRunInTerminalTool(
  extensionClient: ExtensionClient,
  commandAllowlist: string[],
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "runInTerminal",
      extensionRequired: true,
      description:
        "Execute a command in a VS Code integrated terminal and wait for it to complete. " +
        "Returns the exit code and full output — unlike sendTerminalCommand (fire-and-forget), " +
        "this is synchronous. Unlike runCommand, execution is visible in the VS Code terminal panel. " +
        "Requires VS Code 1.93+ with Shell Integration enabled (bash, zsh, fish, or PowerShell). " +
        "Use listTerminals to pick a terminal; if none specified, uses the active terminal.",
      inputSchema: {
        type: "object" as const,
        required: ["command"],
        properties: {
          command: {
            type: "string" as const,
            description:
              "The shell command to execute (no shell metacharacters or newlines)",
          },
          name: {
            type: "string" as const,
            description:
              "Terminal name to run in (from listTerminals). Uses active terminal if omitted.",
          },
          index: {
            type: "integer" as const,
            description:
              "Terminal index (0-based) from listTerminals. Used if name is not specified.",
          },
          timeout: {
            type: "integer" as const,
            description:
              "Seconds to wait for command completion (default: 30, max: 300)",
          },
          show: {
            type: "boolean" as const,
            description:
              "Focus the terminal panel while running (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    // Extension adds a 5 s internal buffer on top of the user timeout — raise
    // the tool ceiling by 10 s so the extension response always arrives before
    // the MCP transport cancels the request.
    timeoutMs: 310_000,
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("runInTerminal");
      }
      const command = requireString(args, "command", 10_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const timeoutSec = optionalInt(args, "timeout", 1, 300) ?? 30;
      const show = optionalBool(args, "show") ?? true;
      const timeoutMs = timeoutSec * 1_000;
      const indexErr = checkIndexWithPrefix(name, index, terminalPrefix);
      if (indexErr) return error(indexErr);

      const cmdErr = validateCommand(command, commandAllowlist);
      if (cmdErr) return error(cmdErr);

      try {
        const result = await extensionClient.executeInTerminal(
          command,
          prefixName(name, terminalPrefix),
          index,
          timeoutMs,
          show,
        );
        if (result === null) {
          return error(
            "Extension did not respond — ensure the VS Code extension is running",
          );
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension connection timed out waiting for the command to complete",
          );
        }
        throw err;
      }
    },
  };
}

export function createDisposeTerminalTool(
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "disposeTerminal",
      extensionRequired: true,
      description:
        "Close and dispose a VS Code integrated terminal. Identify the terminal by name or index (from listTerminals). Requires the VS Code extension.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Terminal name to dispose",
          },
          index: {
            type: "integer" as const,
            description: "Terminal index (0-based) from listTerminals",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("disposeTerminal");
      }
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      if (name === undefined && index === undefined) {
        return error(
          "At least one of 'name' or 'index' must be provided to identify the terminal",
        );
      }
      const indexErr = checkIndexWithPrefix(name, index, terminalPrefix);
      if (indexErr) return error(indexErr);
      try {
        const result = await extensionClient.disposeTerminal(
          prefixName(name, terminalPrefix),
          index,
        );
        if (result === null) {
          return error("Terminal not found");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createSendTerminalCommandTool(
  extensionClient: ExtensionClient,
  commandAllowlist: string[],
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "sendTerminalCommand",
      extensionRequired: true,
      description:
        "Send text or a command to a VS Code integrated terminal. " +
        "Identify the terminal by name or index (from listTerminals). " +
        "Note: sendText is fire-and-forget — use getTerminalOutput afterward to check results. " +
        "Requires the VS Code extension.",
      inputSchema: {
        type: "object" as const,
        required: ["text"],
        properties: {
          text: {
            type: "string" as const,
            description: "Text or command to send to the terminal",
          },
          name: {
            type: "string" as const,
            description: "Terminal name to send to",
          },
          index: {
            type: "integer" as const,
            description: "Terminal index (0-based) from listTerminals",
          },
          addNewline: {
            type: "boolean" as const,
            description: "Append newline to execute as command (default: true)",
          },
          isCommand: {
            type: "boolean" as const,
            description:
              "Set to false when sending REPL input or raw keystrokes (e.g. typing into a Python/Node REPL, pasting text) — skips shell-command validation. Default: true.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("sendTerminalCommand");
      }
      const text = requireString(args, "text", 10_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const addNewline = optionalBool(args, "addNewline") ?? true;
      const isCommand = optionalBool(args, "isCommand") ?? true;

      if (name === undefined && index === undefined) {
        return error(
          "At least one of 'name' or 'index' must be provided to identify the terminal",
        );
      }
      const indexErr = checkIndexWithPrefix(name, index, terminalPrefix);
      if (indexErr) return error(indexErr);

      if (isCommand) {
        const cmdErr = validateCommand(text, commandAllowlist);
        if (cmdErr) return error(cmdErr);
      }

      try {
        const result = await extensionClient.sendTerminalCommand(
          text,
          prefixName(name, terminalPrefix),
          index,
          addNewline,
        );
        if (result === null) {
          return error("Failed to send command to terminal");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}
