import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired, successStructured } from "./utils.js";

export function createGetWorkspaceSettingsTool(
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getWorkspaceSettings",
      description:
        "Read VS Code workspace settings. Optionally filter by section (e.g. 'editor', 'typescript'). " +
        "Returns values with their sources (workspace vs global). ",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {
          section: {
            type: "string" as const,
            description:
              "Settings section to read (e.g. 'editor', 'typescript'). Omit for all.",
          },
          target: {
            type: "string" as const,
            enum: ["workspace", "global"],
            description: "Which scope to read (default: workspace)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        additionalProperties: true,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getWorkspaceSettings");
      }
      const section =
        typeof args.section === "string" ? args.section : undefined;
      const target = typeof args.target === "string" ? args.target : undefined;
      try {
        const result = await extensionClient.getWorkspaceSettings(
          section,
          target,
        );
        if (result === null) return error("Failed to read workspace settings");
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out reading settings");
        }
        throw err;
      }
    },
  };
}
