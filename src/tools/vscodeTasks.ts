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
  successStructured,
} from "./utils.js";

export function createListVSCodeTasksTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "listVSCodeTasks",
      extensionRequired: true,
      description:
        "List all VS Code tasks defined in tasks.json and extensions. Returns name, type, group (build/test/etc), and source for each task.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string" as const,
            description: "Filter tasks by type (e.g. 'shell', 'npm')",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          tasks: { type: "array" },
        },
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("listVSCodeTasks");
      }
      const type = optionalString(args, "type", 64);
      try {
        const result = await extensionClient.listTasks(type);
        if (result === null) {
          return error(
            "Extension did not respond — ensure the VS Code extension is running",
          );
        }
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — task features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}

export function createRunVSCodeTaskTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "runVSCodeTask",
      extensionRequired: true,
      description:
        "Execute a VS Code task by name (from listVSCodeTasks). Waits for completion and returns exit code. Use for build, test, lint tasks defined in tasks.json.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["name"],
        properties: {
          name: {
            type: "string" as const,
            description: "Name of the task to run",
          },
          type: {
            type: "string" as const,
            description:
              "Task type filter (e.g. 'shell', 'npm') to disambiguate tasks with the same name",
          },
          timeout: {
            type: "integer" as const,
            description:
              "Seconds to wait for task completion (default: 60, max: 300)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          exitCode: { type: "integer" },
          name: { type: "string" },
          error: { type: "string" },
        },
      },
    },
    // Extension adds a 5s buffer — raise ceiling so response arrives before MCP cancels
    timeoutMs: 610_000,
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("runVSCodeTask");
      }
      const name = requireString(args, "name", 256);
      const type = optionalString(args, "type", 256);
      const timeoutSec = optionalInt(args, "timeout", 1, 300) ?? 60;
      const timeoutMs = timeoutSec * 1_000;

      try {
        const result = await extensionClient.runTask(name, type, timeoutMs);
        if (result === null) {
          return error(
            "Extension did not respond — ensure the VS Code extension is running",
          );
        }
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out waiting for task completion");
        }
        throw err;
      }
    },
  };
}
