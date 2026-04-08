import type { ExtensionClient } from "../extensionClient.js";
import {
  extensionRequired,
  optionalBool,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
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
        "Get comprehensive information about a symbol in one call: type signature, documentation, definition location, call hierarchy, and reference count. Replaces separate calls to getHover, goToDefinition, getCallHierarchy, and findReferences. Optionally includes type hierarchy and available code actions.",
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
          includeTypeHierarchy: {
            type: "boolean" as const,
            description:
              "Also fetch supertypes/subtypes hierarchy (default: false)",
          },
          includeCodeActions: {
            type: "boolean" as const,
            description:
              "Also fetch available code actions at this position (default: false)",
          },
          includeSiblings: {
            type: "boolean" as const,
            description:
              "Also fetch sibling symbols in the same file — other functions, classes, " +
              "and variables defined alongside the target (default: false)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          hover: {
            anyOf: [
              {
                type: "object",
                properties: {
                  contents: { type: "array", items: { type: "string" } },
                  range: { type: "object" },
                },
              },
              { type: "null" },
            ],
          },
          definition: { anyOf: [{ type: "array" }, { type: "null" }] },
          callHierarchy: { anyOf: [{ type: "object" }, { type: "null" }] },
          references: { anyOf: [{ type: "object" }, { type: "null" }] },
          // Optional fields — not in required; present only when requested
          typeHierarchy: { anyOf: [{ type: "object" }, { type: "null" }] },
          codeActions: { anyOf: [{ type: "array" }, { type: "null" }] },
          siblings: { anyOf: [{ type: "array" }, { type: "null" }] },
        },
        required: ["hover", "definition", "callHierarchy", "references"],
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
      const includeTypeHierarchy =
        optionalBool(args, "includeTypeHierarchy") ?? false;
      const includeCodeActions =
        optionalBool(args, "includeCodeActions") ?? false;
      const includeSiblings = optionalBool(args, "includeSiblings") ?? false;

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(12_000),
      ]);

      const basePromises = [
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
      ] as const;

      const optionalPromises = [
        includeTypeHierarchy
          ? extensionClient.getTypeHierarchy(filePath, line, column, "both", 20)
          : Promise.resolve(null),
        includeCodeActions
          ? extensionClient.getCodeActions(
              filePath,
              line,
              column,
              line,
              column,
              compositeSignal,
            )
          : Promise.resolve(null),
        includeSiblings
          ? extensionClient.getDocumentSymbols(filePath, compositeSignal)
          : Promise.resolve(null),
      ] as const;

      const [
        hoverResult,
        definitionResult,
        callHierarchyResult,
        referencesResult,
        typeHierarchyResult,
        codeActionsResult,
        siblingsResult,
      ] = await Promise.allSettled([...basePromises, ...optionalPromises]);

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
      const typeHierarchy =
        typeHierarchyResult.status === "fulfilled"
          ? typeHierarchyResult.value
          : null;
      const codeActions =
        codeActionsResult.status === "fulfilled"
          ? codeActionsResult.value
          : null;
      const siblingsRaw =
        siblingsResult.status === "fulfilled" ? siblingsResult.value : null;

      // Extract sibling symbol names/kinds from document symbols, excluding target line
      type SymbolEntry = { name: string; kind: string; line: number };
      let siblings: SymbolEntry[] | null = null;
      if (includeSiblings && siblingsRaw !== null) {
        const raw = siblingsRaw as Record<string, unknown>;
        const symList: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : Array.isArray(raw?.symbols)
            ? (raw.symbols as Record<string, unknown>[])
            : [];
        siblings = symList
          .filter((s) => s.line !== line)
          .map((s) => ({
            name: String(s.name),
            kind: String(s.kind),
            line: Number(s.line),
          }));
      }

      return successStructured({
        hover,
        definition,
        callHierarchy,
        references,
        ...(includeTypeHierarchy && { typeHierarchy }),
        ...(includeCodeActions && { codeActions }),
        ...(includeSiblings && { siblings }),
      });
    },
  };
}
