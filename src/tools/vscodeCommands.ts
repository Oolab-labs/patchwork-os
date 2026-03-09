import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import type { Config } from "../config.js";
import { error, extensionRequired, success } from "./utils.js";

export function createExecuteVSCodeCommandTool(extensionClient: ExtensionClient, config: Config) {
  return {
    schema: {
      name: "executeVSCodeCommand",
      description:
        "Execute any registered VS Code command by ID. " +
        "Examples: 'editor.action.formatDocument', 'workbench.action.showAllSymbols', " +
        "'testing.runAll'. Use listVSCodeCommands to discover available commands. " +
        "If --vscode-allow-command flags are set, only those commands are permitted. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["command"],
        properties: {
          command: {
            type: "string" as const,
            description: "VS Code command ID to execute",
          },
          args: {
            type: "array" as const,
            description: "Optional arguments to pass to the command",
            items: {},
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("executeVSCodeCommand");
      }
      const command = args.command;
      if (typeof command !== "string" || command.length === 0) {
        return error("command is required");
      }

      // Allowlist enforcement (bridge-side) — default-deny when no allowlist is configured.
      // VS Code commands are a broad attack surface; require explicit opt-in for each command.
      if (config.vscodeCommandAllowlist.length === 0) {
        return error(
          "executeVSCodeCommand requires an explicit allowlist. " +
          `Use --vscode-allow-command <command-id> to permit specific commands. ` +
          `Run listVSCodeCommands to discover available command IDs.`,
        );
      }
      if (!config.vscodeCommandAllowlist.includes(command)) {
        return error(
          `Command "${command}" is not in the vscodeCommandAllowlist. ` +
          `Allowed: ${config.vscodeCommandAllowlist.join(", ")}. ` +
          `Use --vscode-allow-command ${command} to add it.`,
        );
      }

      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      try {
        const result = await extensionClient.executeVSCodeCommand(command, cmdArgs);
        if (result === null) return error(`Command "${command}" returned null or failed`);
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(`Extension timed out executing "${command}"`);
        }
        throw err;
      }
    },
  };
}

export function createListVSCodeCommandsTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "listVSCodeCommands",
      description:
        "List all registered VS Code commands. Optionally filter by substring. " +
        "Returns up to 2000 commands. Use this to discover command IDs for executeVSCodeCommand. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {
          filter: {
            type: "string" as const,
            description: "Optional substring filter on command IDs",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("listVSCodeCommands");
      }
      const filter = typeof args.filter === "string" ? args.filter : undefined;
      try {
        const result = await extensionClient.listVSCodeCommands(filter);
        if (result === null) return error("Failed to list VS Code commands");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out listing commands");
        }
        throw err;
      }
    },
  };
}
