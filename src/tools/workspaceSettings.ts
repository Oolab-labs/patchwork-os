import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  requireString,
  successStructured,
} from "./utils.js";

// Bridge-side mirror of the extension's BLOCKED_KEY_PREFIXES — defense in depth
// so the check is enforced even if the extension is unavailable or has a bug.
const BLOCKED_SETTING_KEY_PREFIXES = new Set([
  "security",
  "extensions.autoUpdate",
  "extensions.autoInstallDependencies",
  "terminal.integrated.shell",
  "terminal.integrated.shellArgs",
  "terminal.integrated.env",
  "terminal.integrated.profiles",
  "terminal.integrated.defaultProfile",
]);

function isBlockedSettingKey(key: string): boolean {
  return [...BLOCKED_SETTING_KEY_PREFIXES].some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`),
  );
}

export function createSetWorkspaceSettingTool(
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "setWorkspaceSetting",
      description:
        "Write a VS Code workspace setting (dot notation, e.g. editor.tabSize). " +
        "Writes to workspace scope (.vscode/settings.json). Writes to security.* are blocked. ",
      annotations: { destructiveHint: true },
      extensionRequired: true,
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
      outputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: {},
          target: { type: "string" },
        },
        required: ["key"],
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("setWorkspaceSetting");
      }
      const key = requireString(args, "key", 256);
      if (isBlockedSettingKey(key)) {
        return error(
          `Writing to "${key}" is blocked — modifying this setting is not permitted`,
        );
      }
      const value = args.value;
      const target = typeof args.target === "string" ? args.target : undefined;
      try {
        const result = await extensionClient.setWorkspaceSetting(
          key,
          value,
          target,
        );
        if (result === null)
          return error(
            "Failed to write setting — ensure a workspace folder is open",
          );
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out writing setting");
        }
        throw err;
      }
    },
  };
}
