import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired, successStructured } from "./utils.js";

/** Strip prefix from a terminal name (no-op when prefix is empty). */
function stripPrefix(name: string, prefix: string): string {
  if (!prefix) return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function createListTerminalsTool(
  extensionClient: ExtensionClient,
  terminalPrefix = "",
) {
  return {
    schema: {
      name: "listTerminals",
      extensionRequired: true,
      description:
        "List all active VS Code integrated terminals. Returns terminal names, indices, and whether output capture is available. On headless VPS/SSH, use runInTerminal instead.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          terminals: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                index: { type: "integer" as const },
                isActive: { type: "boolean" as const },
                hasShellIntegration: { type: "boolean" as const },
              },
            },
          },
        },
        required: ["terminals"],
      },
    },
    handler: async () => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("terminal features", [
          "Use runCommand to execute shell commands directly",
        ]);
      }
      try {
        const result = await extensionClient.listTerminals();
        if (result === null) {
          return successStructured({ terminals: [] });
        }
        if (!terminalPrefix) {
          return successStructured(result);
        }
        // Filter to this session's terminals and strip prefix from names
        const r = result as { terminals?: Array<{ name?: string }> };
        const filtered = {
          ...result,
          terminals: (r.terminals ?? [])
            .filter(
              (t) =>
                typeof t.name === "string" && t.name.startsWith(terminalPrefix),
            )
            .map((t) => ({
              ...t,
              name:
                typeof t.name === "string"
                  ? stripPrefix(t.name, terminalPrefix)
                  : t.name,
            })),
        };
        return successStructured(filtered);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — terminal features may be unavailable",
          );
        }
        throw err;
      }
    },
  };
}
