import type { ExtensionClient } from "../extensionClient.js";
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

export function createBatchGetHoverTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "batchGetHover",
      extensionRequired: true,
      description:
        "Get hover information (type signatures, docs) for multiple positions in one call. " +
        "More efficient than calling getHover repeatedly. Max 10 items. " +
        "Requires the VS Code extension.",
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
                  description: "Absolute or workspace-relative file path",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                  minimum: 1,
                },
                column: {
                  type: "integer" as const,
                  description: "Column number (1-based)",
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
          results: { type: "array" },
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

      const settled = await Promise.allSettled(
        items.map((item) =>
          extensionClient.getHover(
            item.filePath,
            item.line,
            item.column,
            compositeSignal,
          ),
        ),
      );

      const results = items.map((item, i) => {
        const r = settled[i];
        return {
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          result: r?.status === "fulfilled" ? (r.value ?? null) : null,
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
        "Go to definition for multiple symbols in one call. " +
        "More efficient than calling goToDefinition repeatedly. Max 10 items. " +
        "Requires the VS Code extension.",
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
                  description: "Absolute or workspace-relative file path",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                  minimum: 1,
                },
                column: {
                  type: "integer" as const,
                  description: "Column number (1-based)",
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
          results: { type: "array" },
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

      const settled = await Promise.allSettled(
        items.map((item) =>
          extensionClient.goToDefinition(
            item.filePath,
            item.line,
            item.column,
            compositeSignal,
          ),
        ),
      );

      const results = items.map((item, i) => {
        const r = settled[i];
        return {
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          result: r?.status === "fulfilled" ? (r.value ?? null) : null,
        };
      });

      return successStructured({ results, count: results.length });
    },
  };
}
