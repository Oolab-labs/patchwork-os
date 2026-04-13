import path from "node:path";
import type { Config } from "../config.js";
import { requireString, successStructured } from "./utils.js";

export function createSetActiveWorkspaceFolderTool(config: Config) {
  return {
    schema: {
      name: "setActiveWorkspaceFolder",
      description:
        "Set active workspace folder for file ops. Useful in multi-root workspaces.",
      annotations: { idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["path"],
        properties: {
          path: {
            type: "string" as const,
            description: "Absolute path to the workspace folder to activate",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          set: { type: "boolean" },
          activeWorkspaceFolder: { type: "string" },
        },
        required: ["set", "activeWorkspaceFolder"],
      },
    },
    async handler(args: Record<string, unknown>) {
      const folderPath = requireString(args, "path");
      const resolved = path.resolve(folderPath);
      config.activeWorkspaceFolder = resolved;
      return successStructured({ set: true, activeWorkspaceFolder: resolved });
    },
  };
}
