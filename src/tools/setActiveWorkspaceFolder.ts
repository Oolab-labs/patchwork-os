import type { Config } from "../config.js";
import { requireString, success } from "./utils.js";
import path from "node:path";

export function createSetActiveWorkspaceFolderTool(config: Config) {
  return {
    schema: {
      name: "setActiveWorkspaceFolder",
      description:
        "Set the active workspace folder for subsequent file operations. " +
        "Useful in multi-root workspaces to scope Claude's work to a specific folder. " +
        "Pass a path matching one of the workspace folders from getWorkspaceFolders.",
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
    },
    async handler(args: Record<string, unknown>) {
      const folderPath = requireString(args, "path");
      const resolved = path.resolve(folderPath);
      config.activeWorkspaceFolder = resolved;
      return success({ set: true, activeWorkspaceFolder: resolved });
    },
  };
}
