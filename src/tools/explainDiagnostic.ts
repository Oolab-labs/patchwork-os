import fs from "node:fs";
import type { ExtensionClient } from "../extensionClient.js";
import {
  error,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

const CONTEXT_LINES = 10;
const MAX_CALLERS = 5;

export function createExplainDiagnosticTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "explainDiagnostic",
      description:
        "Bundle diagnostic details + code context (±10 lines) + go-to-definition + callers (up to 5) for a file/line/character position.",
      extensionRequired: true,
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath", "line", "character"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute file path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          character: {
            type: "integer" as const,
            description: "Character/column (1-based)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          diagnostic: {
            anyOf: [
              {
                type: "object" as const,
                properties: {
                  file: { type: "string" as const },
                  line: { type: "integer" as const },
                  column: { type: "integer" as const },
                  severity: { type: "string" as const },
                  message: { type: "string" as const },
                  source: { type: "string" as const },
                },
                required: ["file", "line", "column", "severity", "message"],
              },
              { type: "null" as const },
            ],
          },
          codeContext: {
            type: "array" as const,
            items: { type: "string" as const },
          },
          symbol: {
            anyOf: [{ type: "string" as const }, { type: "null" as const }],
          },
          definition: {
            anyOf: [
              {
                type: "object" as const,
                properties: {
                  file: { type: "string" as const },
                  line: { type: "integer" as const },
                  column: { type: "integer" as const },
                },
                required: ["file", "line", "column"],
              },
              { type: "null" as const },
            ],
          },
          callers: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                file: { type: "string" as const },
                line: { type: "integer" as const },
                column: { type: "integer" as const },
              },
              required: ["name", "file", "line", "column"],
            },
          },
          explanation: { type: "string" as const },
        },
        required: ["codeContext", "callers", "explanation"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const line = requireInt(args, "line", 1);
      const character = requireInt(args, "character", 1);

      let resolved: string;
      try {
        resolved = resolveFilePath(rawPath, workspace);
      } catch (e) {
        return error(
          `Invalid path: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Read file for code context
      let codeContext: string[] = [];
      try {
        const content = await fs.promises.readFile(resolved, "utf-8");
        const lines = content.split("\n");
        const startIdx = Math.max(0, line - 1 - CONTEXT_LINES);
        const endIdx = Math.min(lines.length - 1, line - 1 + CONTEXT_LINES);
        codeContext = lines.slice(startIdx, endIdx + 1).map((l, i) => {
          const lineNum = startIdx + i + 1;
          const marker = lineNum === line ? ">>>" : "   ";
          return `${marker} ${String(lineNum).padStart(4)} | ${l}`;
        });
      } catch {
        codeContext = [];
      }

      // Find matching diagnostic at or near the position
      let diagnostic: {
        file: string;
        line: number;
        column: number;
        severity: string;
        message: string;
        source?: string;
      } | null = null;

      const allDiags = extensionClient.latestDiagnostics;
      const fileDiags = allDiags.get(resolved) ?? [];
      // Find closest diagnostic to requested line
      const nearbyDiags = fileDiags.filter((d) => Math.abs(d.line - line) <= 5);
      if (nearbyDiags.length > 0) {
        // Prefer exact line match, then closest
        const exact = nearbyDiags.find((d) => d.line === line);
        const best = exact ?? nearbyDiags[0]!;
        diagnostic = {
          file: best.file,
          line: best.line,
          column: best.column,
          severity: best.severity,
          message: best.message,
          ...(best.source ? { source: best.source } : {}),
        };
      }

      // Go-to-definition
      let definition: {
        file: string;
        line: number;
        column: number;
      } | null = null;
      let symbol: string | null = null;

      if (extensionClient.isConnected()) {
        try {
          const defResult = await extensionClient.goToDefinition(
            resolved,
            line,
            character,
            signal,
          );
          if (defResult && Array.isArray(defResult) && defResult.length > 0) {
            const first = defResult[0] as Record<string, unknown>;
            const loc = (first.location ?? first) as Record<string, unknown>;
            if (loc) {
              definition = {
                file: String(loc.file ?? loc.uri ?? ""),
                line: Number(loc.line ?? 1),
                column: Number(loc.column ?? 1),
              };
            }
          }
        } catch {
          // best-effort
        }

        // Hover for symbol name
        try {
          const hoverResult = await extensionClient.getHover(
            resolved,
            line,
            character,
          );
          if (hoverResult && typeof hoverResult === "object") {
            const h = hoverResult as Record<string, unknown>;
            const contents = h.contents as unknown[];
            if (Array.isArray(contents) && contents.length > 0) {
              const first = contents[0];
              symbol =
                typeof first === "string"
                  ? first.slice(0, 200)
                  : typeof first === "object" && first !== null
                    ? String(
                        (first as Record<string, unknown>).value ?? "",
                      ).slice(0, 200)
                    : null;
            }
          }
        } catch {
          // best-effort
        }
      }

      // Call hierarchy — incoming callers
      interface CallerInfo {
        name: string;
        file: string;
        line: number;
        column: number;
      }
      const callers: CallerInfo[] = [];

      if (extensionClient.isConnected()) {
        try {
          const hierResult = await extensionClient.getCallHierarchy(
            resolved,
            line,
            character,
            "incoming",
            MAX_CALLERS,
            signal,
          );
          if (hierResult && typeof hierResult === "object") {
            const h = hierResult as Record<string, unknown>;
            const items = (h.items ?? h.callers ?? []) as unknown[];
            for (const item of items.slice(0, MAX_CALLERS)) {
              const it = item as Record<string, unknown>;
              callers.push({
                name: String(it.name ?? "unknown"),
                file: String(it.file ?? it.uri ?? ""),
                line:
                  Number(
                    (it.line ?? it.selectionRange)
                      ? (it.selectionRange as Record<string, unknown>)?.start
                      : 1,
                  ) || 1,
                column: Number(it.column ?? 1),
              });
            }
          }
        } catch {
          // best-effort
        }
      }

      // Build explanation
      const parts: string[] = [];
      if (diagnostic) {
        parts.push(
          `${diagnostic.severity.toUpperCase()} at line ${diagnostic.line}: ${diagnostic.message}`,
        );
      } else {
        parts.push(`No diagnostic found near line ${line}`);
      }
      if (symbol) {
        parts.push(`Symbol: ${symbol}`);
      }
      if (definition) {
        parts.push(`Defined at: ${definition.file}:${definition.line}`);
      }
      if (callers.length > 0) {
        parts.push(
          `${callers.length} caller(s): ${callers.map((c) => c.name).join(", ")}`,
        );
      }

      return successStructured({
        diagnostic,
        codeContext,
        symbol,
        definition,
        callers,
        explanation: parts.join(" | "),
      });
    },
  };
}
