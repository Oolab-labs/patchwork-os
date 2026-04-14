import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  languageIdFromPath,
  optionalInt,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

/**
 * LSP cold-start retry wrapper.
 *
 * On SSH remotes the TypeScript language server takes 5-20 s to index the
 * workspace after Windsurf opens. During that window every LSP call times out
 * at the ExtensionClient REQUEST_TIMEOUT (10 s). Retrying with linear backoff
 * converts most cold-start failures into eventual successes without needing any
 * new extension-side protocol.
 *
 * Strategy:
 *   attempt 1 → immediate
 *   attempt 2 → wait 4 s   (TS server usually ready by here)
 *   attempt 3 → wait 8 s   (catches slow / large workspaces)
 *   → hard error with actionable message
 *
 * Non-timeout errors (e.g. network drop) propagate immediately — we only retry
 * on ExtensionTimeoutError because that is the cold-start signal.
 *
 * The AbortSignal is checked before each wait so cancellation is still fast.
 */
const LSP_RETRY_DELAYS_MS = [4_000, 8_000] as const;

export async function lspWithRetry<T>(
  fn: () => Promise<T | null>,
  signal?: AbortSignal,
  isLspReady?: () => boolean,
): Promise<T | null | "timeout"> {
  // Attempt 1 — no wait
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ExtensionTimeoutError)) throw err;
    // If the language server is already known-ready, a timeout is a real problem
    // (not a cold-start). Skip retries — they won't help.
    if (isLspReady?.()) return "timeout";
  }

  // Retry attempts with increasing backoff
  for (const delayMs of LSP_RETRY_DELAYS_MS) {
    if (signal?.aborted) return "timeout";
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }).catch(() => {
      /* aborted — loop will exit on next iteration */
    });
    if (signal?.aborted) return "timeout";

    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ExtensionTimeoutError)) throw err;
      // still timing out — continue to next delay or fall through
    }
  }

  return "timeout";
}

/** Encode a numeric offset as a base64 cursor string. */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64");
}

/**
 * Decode a cursor from args.
 * - Missing/empty cursor → returns 0 (start of first page).
 * - Non-empty string that fails to decode or parse as a valid non-negative integer
 *   → returns null so callers can return an "Invalid cursor" error to the client.
 */
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string" || cursor === "") return 0;
  try {
    const n = parseInt(Buffer.from(cursor, "base64").toString("utf-8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Returns a readiness checker for a given file path and extension client. */
function readinessChecker(
  extensionClient: ExtensionClient,
  filePath: string,
): () => boolean {
  const langId = languageIdFromPath(filePath);
  return () => extensionClient.lspReadyLanguages?.has(langId) ?? false;
}

/** Standard error returned when an LSP tool exhausts its retry budget. */
export function lspColdStartError() {
  return error(
    "Language server timed out after retries — it may still be indexing the workspace. " +
      "Wait a few seconds and try again, or open a TypeScript file in the editor to trigger indexing.",
  );
}

export function createGoToDefinitionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "goToDefinition",
      extensionRequired: true,
      description:
        "Go to the definition of a symbol at a given position using VS Code LSP.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          message: { type: "string" },
          uri: { type: "string" },
          range: {
            type: "object",
            properties: {
              startLine: { type: "number" },
              startColumn: { type: "number" },
              endLine: { type: "number" },
              endColumn: { type: "number" },
            },
          },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const result = await lspWithRetry(
        () => extensionClient.goToDefinition(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          message: "No definition found at this position",
        });
      }
      return successStructured(result);
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
        "Find all references to a symbol at a given position using VS Code LSP.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
          cursor: {
            type: "string" as const,
            description:
              "Cursor from previous call's nextCursor. Omit on first call.",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          references: {
            type: "array",
            items: {
              type: "object",
              properties: {
                uri: { type: "string" },
                range: { type: "object" },
              },
            },
          },
          total: { type: "integer" },
          nextCursor: { type: "string" },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const PAGE_SIZE = 100;
      const offset = decodeCursor(args.cursor);
      if (offset === null) {
        return error("Invalid cursor");
      }
      const result = await lspWithRetry(
        () => extensionClient.findReferences(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({ found: false, references: [], total: 0 });
      }
      const allRefs = Array.isArray(
        (result as { references?: unknown[] }).references,
      )
        ? (result as { references: unknown[] }).references
        : [];
      const page = allRefs.slice(offset, offset + PAGE_SIZE);
      const out: Record<string, unknown> = {
        ...(result as Record<string, unknown>),
        references: page,
        total: allRefs.length,
      };
      if (offset + PAGE_SIZE < allRefs.length) {
        out.nextCursor = encodeCursor(offset + PAGE_SIZE);
      }
      return successStructured(out);
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
        "Get hover information (type info, documentation) for a symbol at a given position.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          message: { type: "string" },
          contents: { type: "string" },
          range: { type: "object" },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const result = await lspWithRetry(
        () => extensionClient.getHover(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          message: "No hover information at this position",
        });
      }
      return successStructured(result);
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
        "Get available code actions (quick fixes, refactorings) for a range in a file.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
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
      outputSchema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                kind: { type: "string" },
                id: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["actions"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const startLine = requireInt(args, "startLine");
      const startColumn = requireInt(args, "startColumn");
      const endLine = requireInt(args, "endLine");
      const endColumn = requireInt(args, "endColumn");
      const result = await lspWithRetry(
        () =>
          extensionClient.getCodeActions(
            filePath,
            startLine,
            startColumn,
            endLine,
            endColumn,
            signal,
          ),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({ actions: [] });
      }
      return successStructured(result);
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
        "Apply code action by title. Use getCodeActions first to see options.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
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
            description: "Exact action title from getCodeActions output",
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
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
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
      let result: unknown;
      try {
        result = await extensionClient.applyCodeAction(
          filePath,
          startLine,
          startColumn,
          endLine,
          endColumn,
          actionTitle,
          signal,
        );
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Language server timed out — it may still be indexing. " +
              "Wait a few seconds and try again.",
          );
        }
        throw err;
      }
      if (result === null) {
        return error(
          "Extension returned no result — code action may not be available",
        );
      }
      return successStructured(result);
    },
  };
}

export function createPreviewCodeActionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "previewCodeAction",
      extensionRequired: true,
      description:
        "Preview edits a code action would make without applying. Use before applyCodeAction.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
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
            description: "Exact action title from getCodeActions output",
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
      outputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                edits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      range: {
                        type: "object",
                        properties: {
                          startLine: { type: "number" },
                          startColumn: { type: "number" },
                          endLine: { type: "number" },
                          endColumn: { type: "number" },
                        },
                        required: [
                          "startLine",
                          "startColumn",
                          "endLine",
                          "endColumn",
                        ],
                      },
                      newText: { type: "string" },
                    },
                    required: ["range", "newText"],
                  },
                },
              },
              required: ["file", "edits"],
            },
          },
          totalFiles: { type: "number" },
          totalEdits: { type: "number" },
          note: { type: "string" },
        },
        required: ["title", "changes"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use getCodeActions to list available actions first",
          "Use applyCodeAction to apply without preview if extension reconnects",
        ]);
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
      const result = await lspWithRetry(
        () =>
          extensionClient.previewCodeAction(
            filePath,
            startLine,
            startColumn,
            endLine,
            endColumn,
            actionTitle,
            signal,
          ),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return error(
          "Extension returned no result — code action may not be available",
        );
      }
      return successStructured(result);
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
        "Rename symbol across all files via LSP. Returns affected files and edit counts.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
          newName: {
            type: "string" as const,
            description: "New name for the symbol",
          },
        },
        required: ["filePath", "line", "column", "newName"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          success: { type: "boolean" },
          newName: { type: "string" },
          affectedFiles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                editCount: { type: "number" },
              },
              required: ["file", "editCount"],
            },
          },
          totalEdits: { type: "number" },
          error: { type: "string" },
        },
        required: ["success"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
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
      const result = await lspWithRetry(
        () =>
          extensionClient.renameSymbol(filePath, line, column, newName, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return error(
          "Extension returned no result — symbol may not be renameable at this position",
        );
      }
      return successStructured(result);
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
        'Get the call hierarchy for a function or method. Use direction="incoming" to find callers, "outgoing" to see everything it calls, or "both" (default).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
          direction: {
            type: "string" as const,
            enum: ["incoming", "outgoing", "both"],
            description:
              '"incoming"=callers, "outgoing"=callees, "both"=all (default)',
          },
          maxResults: {
            type: "integer" as const,
            description:
              "Max callers/callees per direction (default: 50, max: 200)",
          },
          cursor: {
            type: "string" as const,
            description:
              "Cursor from previous call's nextCursor. Omit on first call.",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          message: { type: "string" },
          incoming: { type: "array", items: { type: "object" } },
          outgoing: { type: "array", items: { type: "object" } },
          incomingTotal: { type: "integer" },
          outgoingTotal: { type: "integer" },
          nextCursor: { type: "string" },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
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
      const PAGE_SIZE = 50;
      const offset = decodeCursor(args.cursor);
      if (offset === null) {
        return error("Invalid cursor");
      }
      const result = await lspWithRetry(
        () =>
          extensionClient.getCallHierarchy(
            filePath,
            line,
            column,
            rawDirection,
            maxResults,
            signal,
          ),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          message:
            "No call hierarchy available at this position — ensure a language server is active",
        });
      }
      const r = result as Record<string, unknown>;
      const allIncoming = Array.isArray(r.incoming)
        ? (r.incoming as unknown[])
        : [];
      const allOutgoing = Array.isArray(r.outgoing)
        ? (r.outgoing as unknown[])
        : [];
      const pageIncoming = allIncoming.slice(offset, offset + PAGE_SIZE);
      const pageOutgoing = allOutgoing.slice(offset, offset + PAGE_SIZE);
      const out: Record<string, unknown> = {
        ...r,
        incoming: pageIncoming,
        outgoing: pageOutgoing,
        incomingTotal: allIncoming.length,
        outgoingTotal: allOutgoing.length,
      };
      if (
        offset + PAGE_SIZE < allIncoming.length ||
        offset + PAGE_SIZE < allOutgoing.length
      ) {
        out.nextCursor = encodeCursor(offset + PAGE_SIZE);
      }
      return successStructured(out);
    },
  };
}

export function createSearchWorkspaceSymbolsTool(
  // _workspace is intentionally unused: symbol search is delegated entirely to
  // the VS Code extension's LSP provider, which handles its own workspace scope.
  // The parameter is retained so the factory signature stays consistent with
  // all other tools in this file and allows future workspace-scoped filtering.
  _workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "searchWorkspaceSymbols",
      extensionRequired: true,
      description:
        "Search workspace symbols (classes, fns, vars, interfaces) by name via LSP.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Symbol name or partial name",
          },
          maxResults: {
            type: "integer" as const,
            description: "Max results (default: 50, max: 200)",
          },
        },
        required: ["query"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          symbols: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                uri: { type: "string" },
                range: { type: "object" },
                containerName: { type: "string" },
              },
              required: ["name", "kind", "uri"],
            },
          },
          count: { type: "number" },
        },
        required: ["symbols", "count"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const query = requireString(args, "query", 256);
      if (query.trim().length === 0) {
        return error("query must not be empty");
      }
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 50;
      const result = await lspWithRetry(
        () => extensionClient.searchSymbols(query, maxResults, signal),
        signal,
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({ symbols: [], count: 0 });
      }
      return successStructured(result);
    },
  };
}

export function createPrepareRenameTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "prepareRename",
      extensionRequired: true,
      description:
        "Check if symbol can be renamed. Returns canRename:false with reason if not. Use before renameSymbol.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "1-based line number",
          },
          column: {
            type: "integer" as const,
            description: "1-based column number",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          canRename: { type: "boolean" },
          reason: { type: "string" },
          placeholder: { type: "string" },
          range: {
            type: "object",
            properties: {
              startLine: { type: "number" },
              startColumn: { type: "number" },
              endLine: { type: "number" },
              endColumn: { type: "number" },
            },
          },
        },
        required: ["canRename"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line", 1);
      const column = requireInt(args, "column", 1);
      if (!extensionClient.isConnected()) {
        return extensionRequired("prepareRename (LSP rename check)", [
          "Use renameSymbol directly if you are confident the symbol supports renaming",
        ]);
      }
      const result = await lspWithRetry(
        () => extensionClient.prepareRename(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      return successStructured(
        result ?? {
          canRename: false,
          reason: "Symbol does not support renaming at this position",
        },
      );
    },
  };
}

export function createFormatRangeTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "formatRange",
      extensionRequired: true,
      description:
        "Format a line range via LSP formatter. Faster than full formatDocument for large files.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          startLine: {
            type: "integer" as const,
            description: "1-based start line (inclusive)",
          },
          endLine: {
            type: "integer" as const,
            description: "1-based end line (inclusive)",
          },
        },
        required: ["filePath", "startLine", "endLine"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          formatted: { type: "boolean" },
          editCount: { type: "number" },
          reason: { type: "string" },
        },
        required: ["formatted"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const startLine = requireInt(args, "startLine", 1);
      const endLine = requireInt(args, "endLine", 1);
      if (endLine < startLine) {
        return error("endLine must be >= startLine");
      }
      if (!extensionClient.isConnected()) {
        return extensionRequired("formatRange (LSP range formatting)", [
          "Use formatDocument to format the entire file instead",
          "Use runCommand with biome or prettier for CLI-based formatting",
        ]);
      }
      const result = await lspWithRetry(
        () => extensionClient.formatRange(filePath, startLine, endLine, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          formatted: false,
          reason: "No formatter available for this file type",
        });
      }
      return successStructured(result);
    },
  };
}

export function createFindImplementationsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "findImplementations",
      extensionRequired: true,
      description:
        "Find implementations of interface, abstract method, or abstract class.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          implementations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                column: { type: "number" },
                endLine: { type: "number" },
                endColumn: { type: "number" },
              },
            },
          },
          count: { type: "number" },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const result = await lspWithRetry(
        () =>
          extensionClient.findImplementations(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          implementations: [],
          count: 0,
        });
      }
      // Cap implementations array at 50 (matches getCallHierarchy baseline).
      const FIND_IMPLEMENTATIONS_MAX = 50;
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (Array.isArray(r.implementations)) {
          const full = r.implementations;
          if (full.length > FIND_IMPLEMENTATIONS_MAX) {
            return successStructured({
              ...r,
              implementations: full.slice(0, FIND_IMPLEMENTATIONS_MAX),
              truncated: true,
              totalCount: full.length,
            });
          }
        }
      }
      return successStructured(result);
    },
  };
}

export function createGoToTypeDefinitionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "goToTypeDefinition",
      extensionRequired: true,
      description:
        "Go to the type definition of a symbol. Unlike goToDefinition (navigates to declaration), this navigates to where the type itself is defined.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          message: { type: "string" },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                column: { type: "number" },
                endLine: { type: "number" },
                endColumn: { type: "number" },
              },
            },
          },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const result = await lspWithRetry(
        () =>
          extensionClient.goToTypeDefinition(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          message: "No type definition found at this position",
        });
      }
      return successStructured(result);
    },
  };
}

export function createGoToDeclarationTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "goToDeclaration",
      extensionRequired: true,
      description:
        "Go to the declaration of a symbol (header file in C/C++, .d.ts entry in TypeScript). Unlike goToDefinition, navigates to the 'declare' statement rather than the implementation.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          message: { type: "string" },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                column: { type: "number" },
                endLine: { type: "number" },
                endColumn: { type: "number" },
              },
            },
          },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("LSP features", [
          "Use runCommand with tsc, eslint, pyright, or biome for CLI-based analysis",
          "Use getDiagnostics for lint/type-check results from CLI linters",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");
      const result = await lspWithRetry(
        () => extensionClient.goToDeclaration(filePath, line, column, signal),
        signal,
        readinessChecker(extensionClient, filePath),
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({
          found: false,
          message: "No declaration found at this position",
        });
      }
      return successStructured(result);
    },
  };
}
