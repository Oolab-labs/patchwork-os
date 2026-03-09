import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { error, extensionRequired, success } from "./utils.js";

export function createGetWorkspaceSettingsTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getWorkspaceSettings",
      description:
        "Read VS Code workspace settings. Optionally filter by section (e.g. 'editor', 'typescript'). " +
        "Returns values with their sources (workspace vs global). " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {
          section: {
            type: "string" as const,
            description: "Settings section to read (e.g. 'editor', 'typescript'). Omit for all.",
          },
          target: {
            type: "string" as const,
            enum: ["workspace", "global"],
            description: "Which scope to read (default: workspace)",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getWorkspaceSettings");
      }
      const section = typeof args.section === "string" ? args.section : undefined;
      const target = typeof args.target === "string" ? args.target : undefined;
      try {
        const result = await extensionClient.getWorkspaceSettings(section, target);
        if (result === null) return error("Failed to read workspace settings");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out reading settings");
        }
        throw err;
      }
    },
  };
}

export function createSetWorkspaceSettingTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "setWorkspaceSetting",
      description:
        "Write a VS Code workspace setting. Use dot notation for the key (e.g. 'editor.tabSize'). " +
        "Writes to workspace scope by default. Writes to 'security.*' are blocked. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["key", "value"],
        properties: {
          key: {
            type: "string" as const,
            description: "Setting key in dot notation (e.g. 'editor.tabSize')",
          },
          value: {
            description: "New value for the setting",
          },
          target: {
            type: "string" as const,
            enum: ["workspace", "global"],
            description: "Which scope to write to (default: workspace)",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("setWorkspaceSetting");
      }
      const key = args.key;
      if (typeof key !== "string" || key.length === 0) return error("key is required");
      const value = args.value;
      const target = typeof args.target === "string" ? args.target : undefined;
      try {
        const result = await extensionClient.setWorkspaceSetting(key, value, target);
        if (result === null) return error("Failed to write setting — ensure a workspace folder is open");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out writing setting");
        }
        throw err;
      }
    },
  };
}
