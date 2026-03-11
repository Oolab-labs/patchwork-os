import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalInt,
  optionalString,
  requireString,
  success,
} from "./utils.js";

export function createListTasksTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "listTasks",
      extensionRequired: true,
      description:
        "List all VS Code tasks defined in .vscode/tasks.json and contributed by extensions. " +
        "Returns task names, types, and groups. Use runTask to execute one. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
    },
    async handler() {
      if (!extensionClient.isConnected()) {
        return extensionRequired("listTasks");
      }
      try {
        const result = await extensionClient.listTasks();
        if (result === null) return error("Failed to list tasks");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out listing tasks");
        }
        throw err;
      }
    },
  };
}

export function createRunTaskTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "runTask",
      extensionRequired: true,
      description:
        "Run a VS Code task by name and wait for it to complete. " +
        "Returns the exit code and duration. Use listTasks to discover available tasks. " +
        "Requires the VS Code extension.",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["name"],
        properties: {
          name: {
            type: "string" as const,
            description: "Task name (from listTasks)",
          },
          type: {
            type: "string" as const,
            description:
              "Task type to disambiguate if multiple tasks share a name",
          },
          timeoutMs: {
            type: "integer" as const,
            description: "Max wait time in ms (default: 60000, max: 300000)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 300_000,
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("runTask");
      }
      const name = requireString(args, "name", 256);
      const type = optionalString(args, "type", 128);
      const timeoutMs = Math.min(
        optionalInt(args, "timeoutMs", 1000, 300_000) ?? 60_000,
        300_000,
      );
      try {
        const result = await extensionClient.runTask(name, type, timeoutMs);
        if (result === null)
          return error(`Task "${name}" not found or failed to start`);
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(`Extension timed out running task "${name}"`);
        }
        throw err;
      }
    },
  };
}
