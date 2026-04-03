import type { ExtensionClient } from "../extensionClient.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createExplainSymbolTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "explainSymbol",
      extensionRequired: true,
      description:
        "Get comprehensive information about a symbol in one call: type signature, documentation, definition location, call hierarchy, and reference count. Replaces separate calls to getHover, goToDefinition, getCallHierarchy, and findReferences.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column number (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("explainSymbol");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(12_000),
      ]);

      const [
        hoverResult,
        definitionResult,
        callHierarchyResult,
        referencesResult,
      ] = await Promise.allSettled([
        extensionClient.getHover(filePath, line, column, compositeSignal),
        extensionClient.goToDefinition(filePath, line, column, compositeSignal),
        extensionClient.getCallHierarchy(
          filePath,
          line,
          column,
          "both",
          10,
          compositeSignal,
        ),
        extensionClient.findReferences(filePath, line, column, compositeSignal),
      ]);

      const hover =
        hoverResult.status === "fulfilled" ? hoverResult.value : null;
      const definition =
        definitionResult.status === "fulfilled" ? definitionResult.value : null;
      const callHierarchy =
        callHierarchyResult.status === "fulfilled"
          ? callHierarchyResult.value
          : null;
      const references =
        referencesResult.status === "fulfilled" ? referencesResult.value : null;

      return success({ hover, definition, callHierarchy, references });
    },
  };
}
