import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { requireString, optionalString, optionalInt, optionalBool, resolveFilePath, success, error, extensionRequired } from "./utils.js";

/** Environment variable names that could enable privilege escalation */
const DANGEROUS_ENV_VARS = new Set([
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS", "NODE_PATH",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME",
  "RUBYOPT", "RUBYLIB",
  "PERL5OPT", "PERL5LIB",
  "CLASSPATH",
  "BASH_ENV", "ENV", "ZDOTDIR",
  "EDITOR", "VISUAL", "SHELL", "HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
  "NPM_CONFIG_SCRIPT_SHELL",
  "CARGO_HOME",
]);

export function createListTerminalsTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "listTerminals",
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
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — terminal features may be unavailable");
        }
        throw err;
      }
    },
  };
}

export function createGetTerminalOutputTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getTerminalOutput",
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
    handler: async (args: Record<string, unknown>) => {
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
      try {
        const result = await extensionClient.getTerminalOutput(name, index, lines);
        if (result === null) {
          return error("Terminal not found");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — terminal features may be unavailable");
        }
        throw err;
      }
    },
  };
}

export function createCreateTerminalTool(workspace: string, extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "createTerminal",
      description:
        "Create a new VS Code integrated terminal. Optionally set a name, working directory, environment variables, and shell. Requires the VS Code extension.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Display name for the terminal",
          },
          cwd: {
            type: "string" as const,
            description: "Working directory for the terminal (must be within workspace)",
          },
          env: {
            type: "object" as const,
            description: "Additional environment variables (key-value pairs, max 50 entries)",
            additionalProperties: { type: "string" as const },
          },
          show: {
            type: "boolean" as const,
            description: "Show the terminal panel after creation (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("createTerminal");
      }
      const name = optionalString(args, "name", 256);
      const rawCwd = optionalString(args, "cwd");
      const resolvedCwd = rawCwd ? resolveFilePath(rawCwd, workspace) : undefined;
      const rawEnv = args.env;
      let env: Record<string, string> | undefined;
      if (rawEnv !== undefined) {
        if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
          return error("'env' must be an object with string key-value pairs");
        }
        const keys = Object.keys(rawEnv as Record<string, unknown>);
        if (keys.length > 50) {
          return error("'env' must have at most 50 entries");
        }
        env = {};
        for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
          if (typeof v !== "string") {
            return error(`env["${k}"] must be a string`);
          }
          if (DANGEROUS_ENV_VARS.has(k.toUpperCase())) {
            return error(`Environment variable "${k}" is blocked for security — it can redirect command execution`);
          }
          env[k] = v;
        }
      }
      const show = optionalBool(args, "show") ?? true;

      try {
        const result = await extensionClient.createTerminal(name, resolvedCwd, env, show);
        if (result === null) {
          return error("Failed to create terminal");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — terminal features may be unavailable");
        }
        throw err;
      }
    },
  };
}

export function createWaitForTerminalOutputTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "waitForTerminalOutput",
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
            description: "JavaScript regex pattern to match against terminal output lines",
          },
          name: {
            type: "string" as const,
            description: "Terminal name to watch (from listTerminals). Uses active terminal if omitted.",
          },
          index: {
            type: "integer" as const,
            description: "Terminal index (0-based) from listTerminals. Used if name is not specified.",
          },
          timeout: {
            type: "integer" as const,
            description: "Seconds to wait before giving up (default: 30, max: 300)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 300_000,
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("waitForTerminalOutput");
      }
      const pattern = requireString(args, "pattern", 1_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const timeoutSec = optionalInt(args, "timeout", 1, 300) ?? 30;
      const timeoutMs = timeoutSec * 1_000;

      // Validate the regex on the bridge side to give a fast, clear error
      try {
        new RegExp(pattern);
      } catch (e) {
        return error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Reject patterns with nested quantifiers — these can cause catastrophic backtracking (ReDoS)
      // when tested repeatedly against terminal output lines over a long polling window.
      if (/\([^)]*[+*]\)[+*?]/.test(pattern) || /\([^)]*\{[^}]+\}\)[+*{?]/.test(pattern)) {
        return error(
          "Pattern contains nested quantifiers (e.g. (a+)+) which can cause catastrophic backtracking. " +
          "Simplify the regex — use a literal string match or a non-nested quantifier.",
        );
      }

      try {
        const result = await extensionClient.waitForTerminalOutput(pattern, name, index, timeoutMs);
        if (result === null) {
          return error("Extension did not respond — ensure the VS Code extension is running");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension connection timed out waiting for terminal output");
        }
        throw err;
      }
    },
  };
}

export function createRunInTerminalTool(
  extensionClient: ExtensionClient,
  commandAllowlist: string[],
) {
  return {
    schema: {
      name: "runInTerminal",
      description:
        "Execute a command in a VS Code integrated terminal and wait for it to complete. " +
        "Returns the exit code and full output — unlike sendTerminalCommand (fire-and-forget), " +
        "this is synchronous. Unlike runCommand, execution is visible in the VS Code terminal panel. " +
        "Requires VS Code 1.93+ with Shell Integration enabled (bash, zsh, fish, or PowerShell). " +
        "Use listTerminals to pick a terminal; if none specified, uses the active terminal.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["command"],
        properties: {
          command: {
            type: "string" as const,
            description: "The shell command to execute (no shell metacharacters or newlines)",
          },
          name: {
            type: "string" as const,
            description: "Terminal name to run in (from listTerminals). Uses active terminal if omitted.",
          },
          index: {
            type: "integer" as const,
            description: "Terminal index (0-based) from listTerminals. Used if name is not specified.",
          },
          timeout: {
            type: "integer" as const,
            description: "Seconds to wait for command completion (default: 30, max: 300)",
          },
          show: {
            type: "boolean" as const,
            description: "Focus the terminal panel while running (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 300_000,
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("runInTerminal");
      }
      const command = requireString(args, "command", 10_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const timeoutSec = optionalInt(args, "timeout", 1, 300) ?? 30;
      const show = optionalBool(args, "show") ?? true;
      const timeoutMs = timeoutSec * 1_000;

      if (/[\n\r]/.test(command)) {
        return error("Command must not contain newlines. Send one command at a time.");
      }
      if (/[;&|`$()<>{}!\\]/.test(command)) {
        return error(
          "Command must not contain shell metacharacters (;&|`$()<>{}!\\). " +
            "These could chain additional commands beyond the allowlist.",
        );
      }

      const firstWord = command.trim().split(/\s+/)[0];
      if (firstWord && !commandAllowlist.includes(firstWord)) {
        return error(
          `Command "${firstWord}" is not in the allowlist. ` +
            `Allowed commands: ${commandAllowlist.join(", ")}. ` +
            `Use --allow-command ${firstWord} to add it.`,
        );
      }

      try {
        const result = await extensionClient.executeInTerminal(command, name, index, timeoutMs, show);
        if (result === null) {
          return error("Extension did not respond — ensure the VS Code extension is running");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension connection timed out waiting for the command to complete");
        }
        throw err;
      }
    },
  };
}

export function createDisposeTerminalTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "disposeTerminal",
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
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("disposeTerminal");
      }
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      if (name === undefined && index === undefined) {
        return error("At least one of 'name' or 'index' must be provided to identify the terminal");
      }
      try {
        const result = await extensionClient.disposeTerminal(name, index);
        if (result === null) {
          return error("Terminal not found");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — terminal features may be unavailable");
        }
        throw err;
      }
    },
  };
}

export function createSendTerminalCommandTool(extensionClient: ExtensionClient, commandAllowlist: string[]) {
  return {
    schema: {
      name: "sendTerminalCommand",
      description:
        "Send text or a command to a VS Code integrated terminal. " +
        "Identify the terminal by name or index (from listTerminals). " +
        "Note: sendText is fire-and-forget — use getTerminalOutput afterward to check results. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: false },
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
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("sendTerminalCommand");
      }
      const text = requireString(args, "text", 10_000);
      const name = optionalString(args, "name", 256);
      const index = optionalInt(args, "index", 0, 100);
      const addNewline = optionalBool(args, "addNewline") ?? true;

      if (name === undefined && index === undefined) {
        return error("At least one of 'name' or 'index' must be provided to identify the terminal");
      }

      // Block newlines — they would split into multiple independent commands in the terminal
      if (/[\n\r]/.test(text)) {
        return error("Terminal command must not contain newlines. Send one command at a time.");
      }

      // Block shell metacharacters — terminal runs in a shell, so these bypass the allowlist
      if (/[;&|`$()<>{}!\\]/.test(text)) {
        return error(
          "Terminal command must not contain shell metacharacters (;&|`$()<>{}!\\). " +
          "Use runCommand for safer execution without a shell.",
        );
      }

      // Validate the first word of the command against the allowlist
      const firstWord = text.trim().split(/\s+/)[0];
      if (firstWord && !commandAllowlist.includes(firstWord)) {
        return error(
          `Command "${firstWord}" is not in the allowlist. ` +
          `Allowed commands: ${commandAllowlist.join(", ")}. ` +
          `Use --allow-command ${firstWord} to add it.`,
        );
      }

      try {
        const result = await extensionClient.sendTerminalCommand(text, name, index, addNewline);
        if (result === null) {
          return error("Failed to send command to terminal");
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — terminal features may be unavailable");
        }
        throw err;
      }
    },
  };
}
