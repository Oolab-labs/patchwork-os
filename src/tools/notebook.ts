import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { error, extensionRequired, optionalInt, requireInt, requireString, resolveFilePath, success } from "./utils.js";

export function createGetNotebookCellsTool(workspace: string, extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getNotebookCells",
      description:
        "Get all cells from a Jupyter notebook (.ipynb) file. " +
        "Returns cell kind (code/markdown), language, source text, and whether output exists. " +
        "Requires the VS Code extension with Jupyter support.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the .ipynb file",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getNotebookCells");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      try {
        const result = await extensionClient.getNotebookCells(file);
        if (result === null) return error("Failed to open notebook — ensure Jupyter extension is installed");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out opening notebook");
        }
        throw err;
      }
    },
  };
}

export function createRunNotebookCellTool(workspace: string, extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "runNotebookCell",
      description:
        "Execute a single cell in a Jupyter notebook and return its output. " +
        "The notebook will be made visible in the editor. " +
        "Cell index is 0-based. Requires the VS Code extension with Jupyter support.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "cellIndex"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the .ipynb file",
          },
          cellIndex: {
            type: "integer" as const,
            description: "Cell index (0-based) to execute",
          },
          timeoutMs: {
            type: "integer" as const,
            description: "Max wait time in ms (default: 30000, max: 300000)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 120_000,
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("runNotebookCell");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const cellIndex = requireInt(args, "cellIndex", 0, 10_000);
      const timeoutMs = Math.min(optionalInt(args, "timeoutMs", 1000, 300_000) ?? 30_000, 300_000);
      try {
        const result = await extensionClient.runNotebookCell(file, cellIndex, timeoutMs);
        if (result === null) return error("Failed to run notebook cell");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out running notebook cell");
        }
        throw err;
      }
    },
  };
}

export function createGetNotebookOutputTool(workspace: string, extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getNotebookOutput",
      description:
        "Get the output of a specific notebook cell without re-running it. " +
        "Returns text output, truncated at 100 KB. Cell index is 0-based. " +
        "Requires the VS Code extension with Jupyter support.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "cellIndex"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the .ipynb file",
          },
          cellIndex: {
            type: "integer" as const,
            description: "Cell index (0-based)",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getNotebookOutput");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const cellIndex = requireInt(args, "cellIndex", 0, 10_000);
      try {
        const result = await extensionClient.getNotebookOutput(file, cellIndex);
        if (result === null) return error("Failed to get notebook cell output");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting notebook output");
        }
        throw err;
      }
    },
  };
}
