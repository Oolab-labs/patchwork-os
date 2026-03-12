import fs from "node:fs";
import path from "node:path";
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

// ---------------------------------------------------------------------------
// Native fallback: parse .vscode/tasks.json and Makefile targets
// ---------------------------------------------------------------------------

type NativeTask = {
  label: string;
  type: string;
  command?: string;
  group?: string;
  source: string;
};

function readVsCodeTasks(workspace: string): NativeTask[] {
  const tasksPath = path.join(workspace, ".vscode", "tasks.json");
  let raw: string;
  try {
    raw = fs.readFileSync(tasksPath, "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    // Strip single-line comments before parsing (tasks.json is JSONC)
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    return [];
  }

  const tasks = (parsed as { tasks: unknown[] }).tasks;
  return tasks
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).label === "string",
    )
    .map((t) => ({
      label: t.label as string,
      type: typeof t.type === "string" ? t.type : "shell",
      command: typeof t.command === "string" ? t.command : undefined,
      group:
        typeof t.group === "string"
          ? t.group
          : typeof t.group === "object" && t.group !== null
            ? String((t.group as Record<string, unknown>).kind ?? "")
            : undefined,
      source: ".vscode/tasks.json",
    }));
}

function readMakefileTargets(workspace: string): NativeTask[] {
  const makefilePath = path.join(workspace, "Makefile");
  let raw: string;
  try {
    raw = fs.readFileSync(makefilePath, "utf-8");
  } catch {
    return [];
  }

  const targets: NativeTask[] = [];
  for (const line of raw.split("\n")) {
    // Match lines like "build:", "test-all:", but not ".PHONY:" or variable assignments
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*:(?:[^=]|$)/.exec(line);
    if (match) {
      targets.push({
        label: match[1] as string,
        type: "shell",
        command: `make ${match[1]}`,
        source: "Makefile",
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function createListTasksTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "listTasks",
      description:
        "List tasks available in the workspace. " +
        "When the VS Code extension is connected, returns all tasks including those contributed by extensions. " +
        "When disconnected, falls back to parsing .vscode/tasks.json and Makefile targets.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
    async handler() {
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.listTasks();
          if (result !== null) return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
        }
      }

      // Native fallback: parse workspace files
      const vscodeTasks = readVsCodeTasks(workspace);
      const makeTargets = readMakefileTargets(workspace);
      const tasks = [...vscodeTasks, ...makeTargets];

      if (tasks.length === 0) {
        return success({
          source: "native",
          note: "Extension not connected. No tasks found in .vscode/tasks.json or Makefile.",
          tasks: [],
        });
      }

      return success({
        source: "native",
        note: "Extension not connected — showing tasks from .vscode/tasks.json and Makefile only. Tasks contributed by VS Code extensions are not available.",
        tasks,
      });
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
