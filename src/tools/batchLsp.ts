import type { ExtensionClient } from "../extensionClient.js";
import { traverse } from "../fp/async.js";
import {
  extensionRequired,
  resolveFilePath,
  successStructured,
} from "./utils.js";

const MAX_BATCH = 10;

interface BatchItem {
  filePath: string;
  line: number;
  column: number;
}

function parseBatchItems(
  raw: unknown,
  workspace: string,
  toolName: string,
): BatchItem[] {
  if (!Array.isArray(raw)) throw new Error("items must be an array");
  if (raw.length === 0) throw new Error("items must not be empty");
  if (raw.length > MAX_BATCH)
    throw new Error(`items exceeds maximum of ${MAX_BATCH}`);

  return raw.map((item: unknown, idx: number) => {
    if (typeof item !== "object" || item === null)
      throw new Error(`${toolName}: items[${idx}] must be an object`);
    const obj = item as Record<string, unknown>;
    if (typeof obj.filePath !== "string")
      throw new Error(`${toolName}: items[${idx}].filePath must be a string`);
    if (
      typeof obj.line !== "number" ||
      !Number.isInteger(obj.line) ||
      obj.line < 1
    )
      throw new Error(
        `${toolName}: items[${idx}].line must be a positive integer`,
      );
    if (
      typeof obj.column !== "number" ||
      !Number.isInteger(obj.column) ||
      obj.column < 1
    )
      throw new Error(
        `${toolName}: items[${idx}].column must be a positive integer`,
      );
    return {
      filePath: resolveFilePath(obj.filePath, workspace),
      line: obj.line,
      column: obj.column,
    };
  });
}

// ── batchGetHover ─────────────────────────────────────────────────────────────

function applyBatchLspVerbosity(
  result: unknown,
  verbosity: "minimal" | "normal" | "verbose",
): unknown {
  if (
    verbosity !== "minimal" ||
    typeof result !== "object" ||
    result === null
  ) {
    return result;
  }
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.contents)) return result;
  return { ...r, contents: (r.contents as unknown[]).slice(0, 1) };
}

export function createBatchGetHoverTool(
  workspace: string,
  extensionClient: ExtensionClient,
  lspVerbosity: "minimal" | "normal" | "verbose" = "normal",
) {
  return {
    schema: {
      name: "batchGetHover",
      extensionRequired: true,
      description:
        "Hover info (type signatures, docs) for up to 10 positions. Prefer over repeated getHover.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array" as const,
            description: "List of positions to hover (max 10)",
            maxItems: MAX_BATCH,
            items: {
              type: "object" as const,
              properties: {
                filePath: {
                  type: "string" as const,
                  description: "Workspace or absolute path",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                  minimum: 1,
                },
                column: {
                  type: "integer" as const,
                  description: "Column (1-based)",
                  minimum: 1,
                },
              },
              required: ["filePath", "line", "column"],
              additionalProperties: false as const,
            },
          },
        },
        required: ["items"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                result: {},
                error: { type: "string" },
              },
              required: ["filePath", "line", "column"],
            },
          },
          count: { type: "integer" },
        },
        required: ["results", "count"],
      },
    },

    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("batchGetHover");
      }

      const items = parseBatchItems(args.items, workspace, "batchGetHover");
      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      const traversed = await traverse(items, (item) =>
        extensionClient.getHover(
          item.filePath,
          item.line,
          item.column,
          compositeSignal,
        ),
      );

      const results = items.map((item, i) => {
        const r = traversed[i];
        if (r?.ok) {
          return {
            filePath: item.filePath,
            line: item.line,
            column: item.column,
            result: applyBatchLspVerbosity(r.value ?? null, lspVerbosity),
          };
        }
        return {
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          result: null,
          error: r?.error ?? "Unknown error",
        };
      });

      return successStructured({ results, count: results.length });
    },
  };
}

// ── batchFindImplementations ──────────────────────────────────────────────────

export function createBatchFindImplementationsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "batchFindImplementations",
      extensionRequired: true,
      description:
        "Find implementations for up to 10 symbols. Prefer over repeated findImplementations.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array" as const,
            description: "List of positions to look up (max 10)",
            maxItems: MAX_BATCH,
            items: {
              type: "object" as const,
              properties: {
                filePath: {
                  type: "string" as const,
                  description: "Workspace or absolute path",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                  minimum: 1,
                },
                column: {
                  type: "integer" as const,
                  description: "Column (1-based)",
                  minimum: 1,
                },
              },
              required: ["filePath", "line", "column"],
              additionalProperties: false as const,
            },
          },
        },
        required: ["items"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                result: {},
                error: { type: "string" },
              },
              required: ["filePath", "line", "column"],
            },
          },
          count: { type: "integer" },
        },
        required: ["results", "count"],
      },
    },

    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("batchFindImplementations");
      }

      const items = parseBatchItems(
        args.items,
        workspace,
        "batchFindImplementations",
      );
      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      const traversed = await traverse(items, (item) =>
        extensionClient.findImplementations(
          item.filePath,
          item.line,
          item.column,
          compositeSignal,
        ),
      );

      const results = items.map((item, i) => {
        const r = traversed[i];
        if (r?.ok) {
          return {
            filePath: item.filePath,
            line: item.line,
            column: item.column,
            result: r.value ?? null,
          };
        }
        return {
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          result: null,
          error: r?.error ?? "Unknown error",
        };
      });

      return successStructured({ results, count: results.length });
    },
  };
}

// ── batchGoToDefinition ───────────────────────────────────────────────────────

export function createBatchGoToDefinitionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "batchGoToDefinition",
      extensionRequired: true,
      description:
        "Go to definition for up to 10 symbols. Prefer over repeated goToDefinition.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array" as const,
            description: "List of positions to look up (max 10)",
            maxItems: MAX_BATCH,
            items: {
              type: "object" as const,
              properties: {
                filePath: {
                  type: "string" as const,
                  description: "Workspace or absolute path",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                  minimum: 1,
                },
                column: {
                  type: "integer" as const,
                  description: "Column (1-based)",
                  minimum: 1,
                },
              },
              required: ["filePath", "line", "column"],
              additionalProperties: false as const,
            },
          },
        },
        required: ["items"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                result: {},
                error: { type: "string" },
              },
              required: ["filePath", "line", "column"],
            },
          },
          count: { type: "integer" },
        },
        required: ["results", "count"],
      },
    },

    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("batchGoToDefinition");
      }

      const items = parseBatchItems(
        args.items,
        workspace,
        "batchGoToDefinition",
      );
      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      const traversed = await traverse(items, (item) =>
        extensionClient.goToDefinition(
          item.filePath,
          item.line,
          item.column,
          compositeSignal,
        ),
      );

      const results = items.map((item, i) => {
        const r = traversed[i];
        if (r?.ok) {
          return {
            filePath: item.filePath,
            line: item.line,
            column: item.column,
            result: r.value ?? null,
          };
        }
        return {
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          result: null,
          error: r?.error ?? "Unknown error",
        };
      });

      return successStructured({ results, count: results.length });
    },
  };
}
