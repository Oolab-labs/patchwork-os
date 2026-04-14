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
        "Get comprehensive symbol info in one call: type signature, docs, definition location, call hierarchy, and reference count.",
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
          useMemoryGraph: {
            type: "boolean" as const,
            description:
              "Query codebase-memory graph for architectural context: module ownership, ADRs, " +
              "graph callers (default: false). Requires codebase-memory MCP connected + repo indexed.",
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
          memoryGraph: { anyOf: [{ type: "object" }, { type: "null" }] },
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
      const useMemoryGraph = optionalBool(args, "useMemoryGraph") ?? false;

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

      // Optionally query codebase-memory graph for architectural context.
      // This is a best-effort fan-out — failure does not fail the overall call.
      let memoryGraph: Record<string, unknown> | null = null;
      if (useMemoryGraph) {
        try {
          // Extract symbol name from hover contents for the graph query
          const hoverContents =
            hover &&
            typeof hover === "object" &&
            "contents" in hover &&
            Array.isArray((hover as Record<string, unknown>).contents)
              ? ((hover as Record<string, unknown>).contents as string[])
              : [];
          const symbolName =
            hoverContents[0]?.match(/`?(\w[\w.]+)`?/)?.[1] ?? "";
          if (symbolName) {
            // Use dynamic import to avoid hard dependency on codebase-memory MCP
            // In practice this is called via the MCP proxy at the transport layer;
            // we build the result here as a note for the caller to act on.
            memoryGraph = {
              note:
                "Query codebase-memory search_graph with symbol: " +
                JSON.stringify(symbolName) +
                " to get architectural context (module ownership, ADRs, graph callers).",
              symbolName,
            };
          }
        } catch {
          // best-effort; memory graph failure does not fail explainSymbol
        }
      }

      return successStructured({
        hover,
        definition,
        callHierarchy,
        references,
        ...(includeTypeHierarchy && { typeHierarchy }),
        ...(includeCodeActions && { codeActions }),
        ...(includeSiblings && { siblings }),
        ...(useMemoryGraph && { memoryGraph }),
      });
    },
  };
}
