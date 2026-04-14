/**
 * navigateToSymbolByName — composite tool that searches for a symbol by name
 * and jumps to its definition in one call. Replaces the 2-call
 * searchSymbols → goToDefinition dance.
 *
 * Implementation notes (from v2.25.25 session plan + real handler inspection):
 * - Client method is `extensionClient.searchSymbols`, NOT `searchWorkspaceSymbols`.
 * - Second arg is a positional number (`maxResults`), NOT an options object.
 * - Handler FLATTENS the LSP response — `symbols` return { name, kind, file,
 *   line, column, containerName } with 1-based line/column and absolute path.
 *   (Not nested range.start as the plan review speculated — verified against
 *   vscode-extension/src/handlers/lsp.ts:461-473.)
 * - `goToDefinition` returns an ARRAY of locations (not a single one), each
 *   with { file, line, column, endLine, endColumn }, or null on no result /
 *   command error. Verified against lsp.ts:71-88.
 * - `openFile` on the client is positional: `openFile(file, line?)`.
 *
 * Defensive shape parsing is still applied — the client methods are typed as
 * `Promise<unknown>` by convention (see project_shape_mismatch_prevention.md).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProgressFn } from "../transport.js";
import {
  error,
  extensionRequired,
  requireString,
  successStructured,
} from "./utils.js";

const execFileAsync = promisify(execFile);

export function createNavigateToSymbolByNameTool(
  extensionClient: ExtensionClient,
  workspace = "",
  hasRg = false,
) {
  return {
    schema: {
      name: "navigateToSymbolByName",
      extensionFallback: true,
      description:
        "Find symbol by name and jump to definition. Replaces searchSymbols→goToDefinition pattern.",
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
        required: ["query"],
        properties: {
          query: {
            type: "string" as const,
            description: "Symbol name to search for",
          },
        },
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          symbol: { type: "object" },
          definition: { type: "object" },
          alternatives: { type: "array" },
        },
        required: ["found"],
      },
    },
    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
      _progress?: ProgressFn,
    ) {
      const query = requireString(args, "query");

      if (!extensionClient.isConnected()) {
        // Headless fallback: use rg to find likely symbol locations
        if (hasRg && workspace) {
          return navigateWithRg(workspace, query, signal);
        }
        return extensionRequired("navigateToSymbolByName", [
          "Install ripgrep (rg) for a partial headless fallback that returns file locations",
          "Note: opening the file in the editor requires the VS Code extension",
        ]);
      }

      // Step 1: search workspace symbols
      const raw = await extensionClient.searchSymbols(query, 5, signal);
      if (raw === null || typeof raw !== "object") {
        return successStructured({ found: false });
      }
      const symbolsList = (raw as { symbols?: unknown }).symbols;
      if (!Array.isArray(symbolsList) || symbolsList.length === 0) {
        return successStructured({ found: false });
      }

      // Defensively extract the first symbol's coordinates
      const best = symbolsList[0] as Record<string, unknown>;
      const symbolFile = typeof best.file === "string" ? best.file : undefined;
      const symbolLine = typeof best.line === "number" ? best.line : undefined;
      const symbolColumn =
        typeof best.column === "number" ? best.column : undefined;
      if (!symbolFile || symbolLine == null || symbolColumn == null) {
        return error("searchSymbols returned unexpected shape for first match");
      }

      // Step 2: resolve to definition
      const defRaw = await extensionClient.goToDefinition(
        symbolFile,
        symbolLine,
        symbolColumn,
        signal,
      );

      // Handler returns an array of locations, or null on no result / error
      if (defRaw === null) {
        return successStructured({
          found: true,
          symbol: best,
          definition: null,
          alternatives: symbolsList.slice(1, 5),
        });
      }
      if (!Array.isArray(defRaw) || defRaw.length === 0) {
        return successStructured({
          found: true,
          symbol: best,
          definition: null,
          alternatives: symbolsList.slice(1, 5),
        });
      }

      const firstDef = defRaw[0] as Record<string, unknown>;
      const defFile =
        typeof firstDef.file === "string" ? firstDef.file : undefined;
      const defLine =
        typeof firstDef.line === "number" ? firstDef.line : undefined;
      if (!defFile || defLine == null) {
        return error("goToDefinition returned unexpected shape");
      }

      // Step 3: open the definition location
      await extensionClient.openFile(defFile, defLine);

      return successStructured({
        found: true,
        symbol: best,
        definition: firstDef,
        alternatives: symbolsList.slice(1, 5),
      });
    },
  };
}

/**
 * Headless rg fallback: find likely symbol declaration lines.
 * Returns file + line coordinates but cannot open file (IDE side-effect).
 * Note in response that navigation requires VS Code extension.
 */
async function navigateWithRg(
  workspace: string,
  query: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof successStructured>> {
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match common declaration patterns: function/class/const/let/var/type/interface/def
  const pattern = `(function|class|const|let|var|type|interface|def|fn)\\s+${escapedQuery}[\\s(<{:]`;
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--json", "--max-count=10", "--type-not=lock", pattern, workspace],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal },
    );

    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          type: string;
          data: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (msg.type !== "match") continue;
        matches.push({
          file: msg.data.path?.text ?? "",
          line: msg.data.line_number ?? 0,
          text: (msg.data.lines?.text ?? "").trim(),
        });
      } catch {
        // skip
      }
    }

    if (matches.length === 0) {
      return successStructured({ found: false });
    }

    const best = matches[0]!;
    return successStructured({
      found: true,
      symbol: {
        name: query,
        file: best.file,
        line: best.line,
        text: best.text,
      },
      definition: null,
      alternatives: matches.slice(1),
      note: "Headless fallback via rg: file location returned. Opening file in editor requires VS Code extension.",
    });
  } catch {
    return successStructured({ found: false });
  }
}
