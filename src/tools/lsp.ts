import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalInt,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createGoToDefinitionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "goToDefinition",
      extensionRequired: true,
      description:
        "Go to the definition of a symbol at a given position using VS Code LSP. Requires the VS Code extension to be connected.",
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
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      try {
        const result = await extensionClient.goToDefinition(
          filePath,
          line,
          column,
          signal,
        );
        if (result === null) {
          return success({
            found: false,
            message: "No definition found at this position",
          });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}

export function createFindReferencesTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "findReferences",
      extensionRequired: true,
      description:
        "Find all references to a symbol at a given position using VS Code LSP. Requires the VS Code extension to be connected.",
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
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      try {
        const result = await extensionClient.findReferences(
          filePath,
          line,
          column,
          signal,
        );
        if (result === null) {
          return success({ found: false, references: [] });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}

export function createGetHoverTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getHover",
      extensionRequired: true,
      description:
        "Get hover information (type info, documentation) for a symbol at a given position. Requires the VS Code extension to be connected.",
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
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      try {
        const result = await extensionClient.getHover(
          filePath,
          line,
          column,
          signal,
        );
        if (result === null) {
          return success({
            found: false,
            message: "No hover information at this position",
          });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}

export function createGetCodeActionsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getCodeActions",
      extensionRequired: true,
      description:
        "Get available code actions (quick fixes, refactorings) for a range in a file. Requires the VS Code extension to be connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          startLine: {
            type: "integer" as const,
            description: "Start line (1-based)",
          },
          startColumn: {
            type: "integer" as const,
            description: "Start column (1-based)",
          },
          endLine: {
            type: "integer" as const,
            description: "End line (1-based)",
          },
          endColumn: {
            type: "integer" as const,
            description: "End column (1-based)",
          },
        },
        required: [
          "filePath",
          "startLine",
          "startColumn",
          "endLine",
          "endColumn",
        ],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const startLine = requireInt(args, "startLine");
      const startColumn = requireInt(args, "startColumn");
      const endLine = requireInt(args, "endLine");
      const endColumn = requireInt(args, "endColumn");
      try {
        const result = await extensionClient.getCodeActions(
          filePath,
          startLine,
          startColumn,
          endLine,
          endColumn,
        );
        if (result === null) {
          return success({ actions: [] });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}

export function createApplyCodeActionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "applyCodeAction",
      extensionRequired: true,
      description:
        "Apply a code action (quick fix, refactoring) by title. First use getCodeActions to see available actions, then use this tool to apply one. Requires the VS Code extension.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          startLine: {
            type: "integer" as const,
            description: "Start line (1-based)",
          },
          startColumn: {
            type: "integer" as const,
            description: "Start column (1-based)",
          },
          endLine: {
            type: "integer" as const,
            description: "End line (1-based)",
          },
          endColumn: {
            type: "integer" as const,
            description: "End column (1-based)",
          },
          actionTitle: {
            type: "string" as const,
            description:
              "Exact title of the code action to apply (from getCodeActions output)",
          },
        },
        required: [
          "filePath",
          "startLine",
          "startColumn",
          "endLine",
          "endColumn",
          "actionTitle",
        ],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const actionTitle = requireString(args, "actionTitle", 500);
      const startLine = requireInt(args, "startLine");
      const startColumn = requireInt(args, "startColumn");
      const endLine = requireInt(args, "endLine");
      const endColumn = requireInt(args, "endColumn");
      try {
        const result = await extensionClient.applyCodeAction(
          filePath,
          startLine,
          startColumn,
          endLine,
          endColumn,
          actionTitle,
        );
        if (result === null) {
          return error(
            "Extension returned no result — code action may not be available",
          );
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — code action may require more time",
          );
        }
        throw err;
      }
    },
  };
}

export function createRenameSymbolTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "renameSymbol",
      extensionRequired: true,
      description:
        "Rename a symbol at a given position across all files using the LSP rename provider. Returns list of affected files and edit counts. Requires the VS Code extension.",
      annotations: { destructiveHint: true },
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
          newName: {
            type: "string" as const,
            description: "New name for the symbol",
          },
        },
        required: ["filePath", "line", "column", "newName"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const newName = requireString(args, "newName", 256);
      if (/[\x00-\x1f]/.test(newName)) {
        return error("newName must not contain control characters");
      }
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      try {
        const result = await extensionClient.renameSymbol(
          filePath,
          line,
          column,
          newName,
        );
        if (result === null) {
          return error(
            "Extension returned no result — symbol may not be renameable at this position",
          );
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — rename may require more time on large projects",
          );
        }
        throw err;
      }
    },
  };
}

export function createGetCallHierarchyTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getCallHierarchy",
      extensionRequired: true,
      description:
        "Get the call hierarchy for a function or method — who calls it (incoming) and what it calls (outgoing). " +
        'Use direction="incoming" to find all callers of a function, "outgoing" to see everything it calls, or "both" (default). ' +
        "Requires the VS Code extension to be connected.",
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
          direction: {
            type: "string" as const,
            enum: ["incoming", "outgoing", "both"],
            description:
              '"incoming" = callers of this function, "outgoing" = functions this calls, "both" = all (default)',
          },
          maxResults: {
            type: "integer" as const,
            description:
              "Maximum callers/callees to return per direction (default: 50, max: 200)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getCallHierarchy");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const rawDirection =
        typeof args.direction === "string" ? args.direction : "both";
      if (!["incoming", "outgoing", "both"].includes(rawDirection)) {
        return error('direction must be "incoming", "outgoing", or "both"');
      }
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 50;
      try {
        const result = await extensionClient.getCallHierarchy(
          filePath,
          line,
          column,
          rawDirection,
          maxResults,
        );
        if (result === null) {
          return success({
            found: false,
            message:
              "No call hierarchy available at this position — ensure a language server is active",
          });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}

export function createSearchWorkspaceSymbolsTool(
  _workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "searchWorkspaceSymbols",
      extensionRequired: true,
      description:
        "Search for symbols (classes, functions, variables, interfaces) by name across the entire workspace using VS Code LSP. Requires the VS Code extension to be connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Symbol name or partial name to search for",
          },
          maxResults: {
            type: "integer" as const,
            description: "Maximum results to return (default: 50, max: 200)",
          },
        },
        required: ["query"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const query = requireString(args, "query", 256);
      if (query.trim().length === 0) {
        return error("query must not be empty");
      }
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features");
      }
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 50;
      try {
        const result = await extensionClient.searchSymbols(query, maxResults);
        if (result === null) {
          return success({ symbols: [], count: 0 });
        }
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — the language server may be slow or unresponsive",
          );
        }
        throw err;
      }
    },
  };
}
