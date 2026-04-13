import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, requireString, successStructured } from "./utils.js";

export function createWatchFilesTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "watchFiles",
      description:
        "Watch glob pattern for file changes (created/modified/deleted). Use unwatchFiles to stop.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "Unique ID for this watcher (used to unwatch later)",
          },
          pattern: {
            type: "string" as const,
            description:
              "Glob pattern to watch (e.g., '**/*.ts', 'src/**/*.{js,jsx}')",
          },
        },
        required: ["id", "pattern"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          watching: { type: "boolean" },
          id: { type: "string" },
          pattern: { type: "string" },
          available: { type: "boolean" },
          error: { type: "string" },
        },
        required: [],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return successStructured({
          available: false,
          error:
            "VS Code extension not connected — file watching requires the extension",
        });
      }
      const id = requireString(args, "id", 100);
      const pattern = requireString(args, "pattern", 500);
      if (/[\x00-\x1f]/.test(id) || /[\x00-\x1f]/.test(pattern)) {
        return error("id and pattern must not contain control characters");
      }
      // Reject patterns that could escape the workspace
      if (
        pattern.startsWith("/") ||
        pattern.startsWith("\\") ||
        pattern.includes("..")
      ) {
        return error(
          "pattern must be relative to the workspace (no absolute paths or '..')",
        );
      }
      try {
        const result = await extensionClient.watchFiles(id, pattern);
        if (result === null) {
          return error("Failed to register file watcher");
        }
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — file watching may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createUnwatchFilesTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "unwatchFiles",
      description:
        "Stop watching files for a previously registered watcher by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "ID of the watcher to remove",
          },
        },
        required: ["id"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          unwatched: { type: "boolean" },
          id: { type: "string" },
          available: { type: "boolean" },
          error: { type: "string" },
        },
        required: [],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return successStructured({
          available: false,
          error:
            "VS Code extension not connected — file watching requires the extension",
        });
      }
      const id = requireString(args, "id", 100);
      try {
        const result = await extensionClient.unwatchFiles(id);
        if (result === null) {
          return error("Failed to unregister file watcher");
        }
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — file watching may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}
