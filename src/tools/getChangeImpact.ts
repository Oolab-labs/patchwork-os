import type { ExtensionClient } from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

interface ChangedSymbolInput {
  name: string;
  line?: number;
}

interface SymbolImpact {
  name: string;
  referenceCount: number;
  affectedFiles: string[];
  externalRefCount: number;
}

function blastRadiusLevel(maxRefs: number): "low" | "medium" | "high" {
  if (maxRefs >= 20) return "high";
  if (maxRefs >= 5) return "medium";
  return "low";
}

export function createGetChangeImpactTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getChangeImpact",
      extensionRequired: true,
      description:
        "Analyze the blast radius after editing a file. Returns diagnostics on the file " +
        "and reference counts for changed symbols. Use after edits to understand what " +
        "other code may be affected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description:
              "Absolute or workspace-relative path of the edited file",
          },
          changedSymbols: {
            type: "array" as const,
            description:
              "Symbols that were changed (optional). Each entry must have a name; " +
              "optionally a line number to disambiguate overloads.",
            maxItems: 10,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                line: { type: "integer" as const },
              },
              required: ["name"],
              additionalProperties: false as const,
            },
          },
          workspaceOnly: {
            type: "boolean" as const,
            description:
              "Filter references to workspace files only (default: true). " +
              "External refs (node_modules, stdlib) are counted separately.",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          diagnostics: { type: "object" },
          symbolImpact: { type: "array" },
          blastRadius: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string" },
        },
        required: ["diagnostics", "symbolImpact", "blastRadius", "summary"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getChangeImpact");
      }

      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const workspaceOnly = args.workspaceOnly !== false; // default true
      const maxRefsPerSymbol =
        optionalInt(args, "maxReferencesPerSymbol") ?? 20;

      // Validate changedSymbols array
      const rawSymbols = args.changedSymbols;
      const changedSymbols: ChangedSymbolInput[] = [];
      if (Array.isArray(rawSymbols)) {
        for (const s of rawSymbols.slice(0, 10)) {
          const sym = s as Record<string, unknown>;
          if (typeof sym?.name === "string") {
            changedSymbols.push({
              name: sym.name,
              line: typeof sym.line === "number" ? sym.line : undefined,
            });
          }
        }
      }

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      // 1. Get live diagnostics for the file
      const diagnosticsRaw = await extensionClient
        .getDiagnostics(filePath)
        .catch(() => null);

      const diagItems = Array.isArray(diagnosticsRaw) ? diagnosticsRaw : [];
      const errors = diagItems.filter((d) => d.severity === "error").length;
      const warnings = diagItems.filter((d) => d.severity === "warning").length;

      if (compositeSignal.aborted) {
        return error("Request aborted");
      }

      const symbolImpact: SymbolImpact[] = [];

      if (changedSymbols.length > 0) {
        // 2. Get document symbols to find positions of named symbols
        const docSymsRaw = await extensionClient
          .getDocumentSymbols(filePath, compositeSignal)
          .catch(() => null);

        const docSyms: Record<string, unknown>[] = (() => {
          if (!docSymsRaw) return [];
          const r = docSymsRaw as Record<string, unknown>;
          if (Array.isArray(r)) return r as Record<string, unknown>[];
          if (Array.isArray(r?.symbols))
            return r.symbols as Record<string, unknown>[];
          return [];
        })();

        // 3. Match requested symbols to their positions
        const symbolPositions: Array<{
          name: string;
          line: number;
          column: number;
        }> = [];
        for (const wanted of changedSymbols) {
          if (compositeSignal.aborted) break;
          const match = docSyms.find(
            (s) =>
              s.name === wanted.name &&
              (wanted.line === undefined || s.line === wanted.line),
          );
          if (match) {
            symbolPositions.push({
              name: wanted.name,
              line: Number(match.selectionLine ?? match.line),
              column: Number(match.selectionColumn ?? match.column ?? 1),
            });
          }
        }

        // 4. Find references for matched symbols (max 5 in parallel)
        const CONCURRENCY = 5;
        for (let i = 0; i < symbolPositions.length; i += CONCURRENCY) {
          if (compositeSignal.aborted) break;
          const batch = symbolPositions.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map((pos) =>
              extensionClient.findReferences(
                filePath,
                pos.line,
                pos.column,
                compositeSignal,
              ),
            ),
          );

          for (let j = 0; j < batch.length; j++) {
            const pos = batch[j];
            if (!pos) continue;
            const result = results[j];
            const refsRaw =
              result?.status === "fulfilled"
                ? (result.value as Record<string, unknown>)
                : null;
            const allRefs: Record<string, unknown>[] = Array.isArray(
              refsRaw?.references,
            )
              ? (refsRaw.references as Record<string, unknown>[])
              : [];

            const wsRefs = allRefs.filter((r) =>
              workspaceOnly
                ? typeof r.file === "string" &&
                  (r.file.startsWith(workspace) ||
                    !r.file.includes("node_modules"))
                : true,
            );
            const externalRefCount = allRefs.length - wsRefs.length;

            const affectedFiles = [
              ...new Set(
                wsRefs
                  .map((r) => r.file)
                  .filter((f): f is string => typeof f === "string"),
              ),
            ];

            const referenceCount = Math.min(wsRefs.length, maxRefsPerSymbol);

            symbolImpact.push({
              name: pos.name,
              referenceCount,
              affectedFiles,
              externalRefCount,
            });
          }
        }
      }

      const maxRefs = symbolImpact.reduce(
        (m, s) => Math.max(m, s.referenceCount),
        0,
      );
      const blastRadius = blastRadiusLevel(maxRefs);

      const parts: string[] = [
        `${errors} error(s), ${warnings} warning(s) in ${filePath}`,
      ];
      if (symbolImpact.length > 0) {
        const affected = [
          ...new Set(symbolImpact.flatMap((s) => s.affectedFiles)),
        ].length;
        parts.push(
          `${symbolImpact.length} changed symbol(s) affect ${affected} file(s)`,
        );
      }
      const summary = `${parts.join("; ")}. Blast radius: ${blastRadius}.`;

      return successStructured({
        diagnostics: { errors, warnings, items: diagItems.slice(0, 50) },
        symbolImpact,
        blastRadius,
        summary,
      });
    },
  };
}
