import fs from "node:fs";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  execSafe,
  extensionRequired,
  languageIdFromPath,
  optionalInt,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

// --- Short-lived LSP result cache ---
interface LspCacheEntry {
  result: unknown;
  mtimeMs: number;
  expiresAt: number;
}
const lspCache = new Map<string, LspCacheEntry>();
const LSP_CACHE_TTL_MS = 3_000;
const LSP_CACHE_MAX = 100;

function lspCacheGet(key: string, currentMtimeMs: number): unknown | undefined {
  const entry = lspCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt || entry.mtimeMs !== currentMtimeMs) {
    lspCache.delete(key);
    return undefined;
  }
  // LRU: move to end so FIFO eviction keeps most-recently-used entries
  lspCache.delete(key);
  lspCache.set(key, entry);
  return entry.result;
}

function lspCacheSet(key: string, result: unknown, mtimeMs: number): void {
  if (lspCache.size >= LSP_CACHE_MAX) {
    // Evict oldest entry
    const firstKey = lspCache.keys().next().value;
    if (firstKey !== undefined) lspCache.delete(firstKey);
  }
  lspCache.set(key, {
    result,
    mtimeMs,
    expiresAt: Date.now() + LSP_CACHE_TTL_MS,
  });
}

// Language-specific regex patterns for symbol definitions
const DEFINITION_PATTERNS: Record<string, string> = {
  typescript: String.raw`(export\s+)?(class|interface|type|enum|function|const|let|var|async\s+function)\s+`,
  typescriptreact: String.raw`(export\s+)?(class|interface|type|enum|function|const|let|var|async\s+function)\s+`,
  javascript: String.raw`(export\s+)?(class|function|const|let|var|async\s+function)\s+`,
  javascriptreact: String.raw`(export\s+)?(class|function|const|let|var|async\s+function)\s+`,
  python: String.raw`(class|def|async\s+def)\s+`,
  rust: String.raw`(pub\s+)?(fn|struct|enum|trait|impl|type|mod|const|static)\s+`,
  go: String.raw`(func|type|var|const)\s+`,
};

const LANG_GLOBS: Record<string, string> = {
  typescript: "*.{ts,tsx}",
  typescriptreact: "*.{ts,tsx}",
  javascript: "*.{js,jsx,mjs,cjs}",
  javascriptreact: "*.{js,jsx,mjs,cjs}",
  python: "*.py",
  rust: "*.rs",
  go: "*.go",
};

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the word (symbol name) at a given 1-based line/column from file content */
export function wordAtPosition(
  content: string,
  line: number,
  column: number,
): string | null {
  const lines = content.split("\n");
  const lineText = lines[line - 1];
  if (!lineText) return null;
  const col = column - 1;
  // Expand outward from column to find word boundaries
  const wordRegex = /[\w$]/;
  let start = col;
  let end = col;
  while (start > 0 && wordRegex.test(lineText[start - 1]!)) start--;
  while (end < lineText.length && wordRegex.test(lineText[end]!)) end++;
  const word = lineText.slice(start, end);
  return word.length > 0 ? word : null;
}

interface GrepMatch {
  filePath: string;
  line: number;
  column: number;
  text: string;
}

async function grepForSymbol(
  workspace: string,
  pattern: string,
  glob: string | undefined,
  maxResults: number,
): Promise<GrepMatch[]> {
  const args = ["-n", "--column", "-H", "--no-heading"];
  if (glob) {
    args.push("--glob", glob);
  }
  args.push("-e", pattern, workspace);

  const result = await execSafe("rg", args, {
    cwd: workspace,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });

  const matches: GrepMatch[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    // Format: filepath:line:column:text
    const m = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (m) {
      matches.push({
        filePath: m[1]!,
        line: Number.parseInt(m[2]!, 10),
        column: Number.parseInt(m[3]!, 10),
        text: m[4]!.trim(),
      });
    }
    if (matches.length >= maxResults) break;
  }
  return matches;
}

export function createGoToDefinitionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "goToDefinition",
      description:
        "Go to the definition of a symbol at a given position. Uses VS Code LSP when connected, falls back to lexical grep search otherwise (may include false positives).",
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
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");

      // Try extension first (semantic)
      if (extensionClient.isConnected()) {
        try {
          // Check cache
          const stat = await fs.promises.stat(filePath).catch(() => null);
          const cacheKey = `def:${filePath}:${line}:${column}`;
          if (stat) {
            const cached = lspCacheGet(cacheKey, stat.mtimeMs);
            if (cached !== undefined) return success(cached);
          }
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
          if (stat) lspCacheSet(cacheKey, result, stat.mtimeMs);
          return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to grep fallback
        }
      }

      // Grep fallback: extract symbol at position, search for definition patterns
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const symbol = wordAtPosition(content, line, column);
        if (!symbol) {
          return success({
            found: false,
            message: "No symbol found at this position",
          });
        }

        const langId = languageIdFromPath(filePath);
        const defPattern = DEFINITION_PATTERNS[langId];
        const glob = LANG_GLOBS[langId];

        // Search for definition-like patterns: "class Foo", "function Foo", etc.
        const pattern = defPattern
          ? `${defPattern}${escapeRegex(symbol)}\\b`
          : `(class|function|def|fn|type|interface|struct|const|let|var)\\s+${escapeRegex(symbol)}\\b`;

        const matches = await grepForSymbol(workspace, pattern, glob, 10);

        if (matches.length === 0) {
          return success({
            found: false,
            source: "lexical-grep",
            message: `No definition-like pattern found for "${symbol}"`,
          });
        }

        return success({
          found: true,
          source: "lexical-grep",
          symbol,
          definitions: matches.map((m) => ({
            filePath: m.filePath,
            line: m.line,
            column: m.column,
            text: m.text,
          })),
          warning:
            "Results are from text search, not semantic analysis — may include false positives",
        });
      } catch (err) {
        return error(
          `Grep fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      description:
        "Find all references to a symbol at a given position. Uses VS Code LSP when connected, falls back to lexical grep search otherwise (may include false positives from identically-named symbols).",
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
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line");
      const column = requireInt(args, "column");

      // Try extension first (semantic)
      if (extensionClient.isConnected()) {
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
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to grep fallback
        }
      }

      // Grep fallback: find all occurrences of the word
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const symbol = wordAtPosition(content, line, column);
        if (!symbol) {
          return success({
            found: false,
            references: [],
            message: "No symbol found at this position",
          });
        }

        const langId = languageIdFromPath(filePath);
        const glob = LANG_GLOBS[langId];
        // Word-boundary search for exact symbol name
        const pattern = `\\b${escapeRegex(symbol)}\\b`;
        const matches = await grepForSymbol(workspace, pattern, glob, 100);

        return success({
          found: matches.length > 0,
          source: "lexical-grep",
          symbol,
          references: matches.map((m) => ({
            filePath: m.filePath,
            line: m.line,
            column: m.column,
            text: m.text,
          })),
          count: matches.length,
          warning:
            "Results are from text search — may include false positives from identically-named symbols in different scopes",
        });
      } catch (err) {
        return error(
          `Grep fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
        // Check cache
        const stat = await fs.promises.stat(filePath).catch(() => null);
        const cacheKey = `hover:${filePath}:${line}:${column}`;
        if (stat) {
          const cached = lspCacheGet(cacheKey, stat.mtimeMs);
          if (cached !== undefined) return success(cached);
        }
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
        if (stat) lspCacheSet(cacheKey, result, stat.mtimeMs);
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
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "searchWorkspaceSymbols",
      description:
        "Search for symbols (classes, functions, variables, interfaces) by name across the entire workspace. Uses VS Code LSP when connected (semantically accurate), falls back to ripgrep pattern matching otherwise.",
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
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 50;

      // Try extension first (semantic)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.searchSymbols(query, maxResults);
          if (result === null) {
            return success({ symbols: [], count: 0 });
          }
          return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to grep fallback
        }
      }

      // Grep fallback: search for definition patterns matching the query
      try {
        const escaped = escapeRegex(query);
        // Generic definition pattern covering common languages
        const pattern = `(export\\s+)?(class|interface|type|enum|function|const|let|var|async\\s+function|def|async\\s+def|fn|struct|trait|impl|mod)\\s+${escaped}`;

        // Scope search to common source file types to avoid scanning binaries/node_modules
        const defaultGlob =
          "*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,c,cpp,h,hpp,rb,php,swift,kt,scala}";
        const matches = await grepForSymbol(
          workspace,
          pattern,
          defaultGlob,
          maxResults,
        );

        return success({
          source: "lexical-grep",
          symbols: matches.map((m) => ({
            name: query,
            filePath: m.filePath,
            line: m.line,
            column: m.column,
            text: m.text,
          })),
          count: matches.length,
          warning:
            "Results are from text pattern matching, not semantic symbol resolution",
        });
      } catch (err) {
        return error(
          `Grep fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
