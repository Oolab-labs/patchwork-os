import fs from "node:fs/promises";
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

const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: Array<{
    output_type: string;
    text?: string | string[];
    data?: Record<string, unknown>;
  }>;
  metadata?: { language_info?: { name?: string } };
}

interface NotebookFormat {
  cells?: NotebookCell[];
  metadata?: {
    language_info?: { name?: string };
    kernelspec?: { language?: string };
  };
  nbformat?: number;
}

function sourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

type NotebookOutput = NonNullable<NotebookCell["outputs"]>[number];

function outputToText(output: NotebookOutput): string {
  if (output.output_type === "stream" && output.text) {
    return sourceToString(output.text as string | string[]);
  }
  if (
    (output.output_type === "execute_result" ||
      output.output_type === "display_data") &&
    output.data
  ) {
    const text = output.data["text/plain"];
    if (typeof text === "string") return text;
    if (Array.isArray(text)) return text.join("");
  }
  if (output.output_type === "error") {
    const o = output as unknown as {
      ename?: string;
      evalue?: string;
      traceback?: string[];
    };
    return `${o.ename ?? "Error"}: ${o.evalue ?? ""}${o.traceback ? `\n${o.traceback.join("\n")}` : ""}`;
  }
  return "";
}

async function parseNotebook(
  file: string,
): Promise<{ nb: NotebookFormat; raw: string } | null> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const nb = JSON.parse(raw) as NotebookFormat;
    if (!Array.isArray(nb.cells)) return null;
    return { nb, raw };
  } catch {
    return null;
  }
}

export function createGetNotebookCellsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getNotebookCells",
      description:
        "Get all cells from a Jupyter notebook (.ipynb) file. " +
        "Returns cell kind (code/markdown), language, source text, and whether output exists. " +
        "Works without the VS Code extension by parsing the .ipynb JSON directly.",
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
      const file = resolveFilePath(requireString(args, "file"), workspace);
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.getNotebookCells(file);
          if (result !== null) return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
        }
      }
      // Native fallback: parse .ipynb JSON directly
      const parsed = await parseNotebook(file);
      if (!parsed)
        return error(
          "Failed to parse notebook — ensure it is a valid .ipynb file",
        );
      const { nb } = parsed;
      const defaultLang =
        nb.metadata?.language_info?.name ??
        nb.metadata?.kernelspec?.language ??
        "python";
      const cells = (nb.cells ?? []).map((cell, idx) => ({
        index: idx,
        kind: cell.cell_type === "markdown" ? "markdown" : "code",
        language: cell.cell_type === "markdown" ? "markdown" : defaultLang,
        source: sourceToString(cell.source),
        hasOutput: Array.isArray(cell.outputs) && cell.outputs.length > 0,
      }));
      return success({ cells, source: "native-fs" });
    },
  };
}

export function createRunNotebookCellTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "runNotebookCell",
      extensionRequired: true,
      description:
        "Execute a single cell in a Jupyter notebook and return its output. " +
        "The notebook will be made visible in the editor. " +
        "Cell index is 0-based. Requires the VS Code extension with Jupyter support.",
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
      const timeoutMs = Math.min(
        optionalInt(args, "timeoutMs", 1000, 300_000) ?? 30_000,
        300_000,
      );
      try {
        const result = await extensionClient.runNotebookCell(
          file,
          cellIndex,
          timeoutMs,
        );
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

export function createGetNotebookOutputTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getNotebookOutput",
      description:
        "Get the output of a specific notebook cell without re-running it. " +
        "Returns text output, truncated at 100 KB. Cell index is 0-based. " +
        "Works without the VS Code extension by reading stored outputs from the .ipynb JSON.",
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
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const cellIndex = requireInt(args, "cellIndex", 0, 10_000);
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.getNotebookOutput(
            file,
            cellIndex,
          );
          if (result !== null) return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
        }
      }
      // Native fallback: extract stored outputs from .ipynb JSON
      const parsed = await parseNotebook(file);
      if (!parsed)
        return error(
          "Failed to parse notebook — ensure it is a valid .ipynb file",
        );
      const cells = parsed.nb.cells ?? [];
      if (cellIndex >= cells.length)
        return error(
          `Cell index ${cellIndex} out of range (notebook has ${cells.length} cells)`,
        );
      const cell = cells[cellIndex];
      if (!cell) return error(`Cell ${cellIndex} not found`);
      const outputs = cell.outputs ?? [];
      if (outputs.length === 0)
        return success({ output: "", hasOutput: false, source: "native-fs" });
      let combined = outputs.map(outputToText).join("");
      if (combined.length > MAX_OUTPUT_BYTES)
        combined = `${combined.slice(0, MAX_OUTPUT_BYTES)}\n[truncated]`;
      return success({
        output: combined,
        hasOutput: true,
        source: "native-fs",
      });
    },
  };
}
