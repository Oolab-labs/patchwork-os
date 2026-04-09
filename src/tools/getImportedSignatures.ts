import fs from "node:fs";
import type { ExtensionClient } from "../extensionClient.js";
import {
  extensionRequired,
  optionalInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

const MAX_HOVER_CHARS = 4_000;
const DEFAULT_MAX_IMPORTS = 15;
const HARD_MAX_IMPORTS = 20;
const CONCURRENCY = 5;

interface SymbolRef {
  name: string;
  localName: string;
  specifier: string;
  line: number; // 1-based
  column: number; // 1-based
}

/**
 * Parse named imports from ES module import statements.
 * Handles: named `{ A, B as C }`, default, type imports.
 * Skips: namespace `* as X`.
 * Returns positions of each symbol name for goToDefinition calls.
 */
function parseImportedSymbolRefs(source: string): SymbolRef[] {
  const results: SymbolRef[] = [];
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Only process lines that start an import statement
    if (!/^\s*import\b/.test(line)) {
      i++;
      continue;
    }

    // Collect the full import statement (may span multiple lines)
    const stmtLines: Array<{ lineIdx: number; text: string }> = [
      { lineIdx: i, text: line },
    ];
    let combined = line;

    // Extend if 'from "..."' not yet present
    while (
      stmtLines.length < 10 &&
      i + stmtLines.length < lines.length &&
      !/from\s+['"]/.test(combined)
    ) {
      const nextLine = lines[i + stmtLines.length] ?? "";
      stmtLines.push({ lineIdx: i + stmtLines.length, text: nextLine });
      combined += `\n${nextLine}`;
    }

    i += stmtLines.length;

    // Skip namespace imports: import * as X from '...'
    if (/import\s+(?:type\s+)?\*\s+as/.test(combined)) continue;

    // Extract module specifier
    const specMatch = combined.match(/from\s+['"]([^'"]+)['"]/);
    if (!specMatch?.[1]) continue;
    const specifier = specMatch[1];

    // Extract named imports: import { A, B as C, type D } from '...'
    const braceMatch = combined.match(/\{([^}]*)\}/);
    if (braceMatch?.[1]) {
      for (const entry of braceMatch[1].split(",")) {
        // Strip leading 'type' keyword from individual entries
        const cleaned = entry.trim().replace(/^type\s+/, "");
        if (!cleaned) continue;
        const asParts = cleaned.split(/\s+as\s+/);
        const name = asParts[0]?.trim() ?? "";
        const localName = asParts[1]?.trim() ?? name;
        if (!name || name === "default") continue;

        // Find which line this name appears on (in the brace section)
        let foundLine = stmtLines[0]?.lineIdx ?? i - stmtLines.length;
        let foundCol = 1;
        for (const { lineIdx, text } of stmtLines) {
          const braceStart = text.indexOf("{");
          const searchIn = braceStart >= 0 ? text.slice(braceStart) : text;
          const nameRe = new RegExp(`\\b${name}\\b`);
          const m = nameRe.exec(searchIn);
          if (m) {
            foundLine = lineIdx;
            foundCol = (braceStart >= 0 ? braceStart : 0) + m.index + 1;
            break;
          }
        }

        results.push({
          name,
          localName,
          specifier,
          line: foundLine + 1,
          column: foundCol,
        });
      }
    } else {
      // Default import: import DefaultName from '...'
      const defaultMatch = combined.match(/import\s+(?:type\s+)?(\w+)\s+from/);
      if (defaultMatch?.[1]) {
        const name = defaultMatch[1];
        let foundLine = stmtLines[0]?.lineIdx ?? i - stmtLines.length;
        let foundCol = 1;
        for (const { lineIdx, text } of stmtLines) {
          const m = new RegExp(`\\b${name}\\b`).exec(text);
          if (m) {
            foundLine = lineIdx;
            foundCol = m.index + 1;
            break;
          }
        }
        results.push({
          name,
          localName: name,
          specifier,
          line: foundLine + 1,
          column: foundCol,
        });
      }
    }
  }

  return results;
}

export function createGetImportedSignaturesTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getImportedSignatures",
      extensionRequired: true,
      description:
        "Resolve imported symbols to their type signatures. " +
        "Prevents hallucinating API shapes — use before calling unfamiliar functions.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          maxImports: {
            type: "integer" as const,
            description: `Maximum imports to resolve (default ${DEFAULT_MAX_IMPORTS}, max ${HARD_MAX_IMPORTS})`,
            minimum: 1,
            maximum: HARD_MAX_IMPORTS,
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          imports: { type: "array" },
          count: { type: "integer" },
          resolved: { type: "integer" },
          unresolved: { type: "array", items: { type: "string" } },
        },
        required: ["imports", "count", "resolved", "unresolved"],
      },
    },

    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getImportedSignatures");
      }

      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const maxImports = Math.min(
        optionalInt(args, "maxImports") ?? DEFAULT_MAX_IMPORTS,
        HARD_MAX_IMPORTS,
      );

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      // Read source file
      let source: string;
      try {
        source = await fs.promises.readFile(filePath, "utf-8");
      } catch {
        return successStructured({
          imports: [],
          count: 0,
          resolved: 0,
          unresolved: [],
          message: `Cannot read file: ${filePath}`,
        });
      }

      // Parse import statements to find symbol refs
      const symbolRefs = parseImportedSymbolRefs(source).slice(0, maxImports);

      if (symbolRefs.length === 0) {
        return successStructured({
          imports: [],
          count: 0,
          resolved: 0,
          unresolved: [],
        });
      }

      // Resolve each symbol via goToDefinition + getHover (5 concurrent)
      const resolved: Array<{
        name: string;
        source: string;
        signature: string | null;
        definitionFile: string | null;
      }> = [];
      const unresolved: string[] = [];

      for (let i = 0; i < symbolRefs.length; i += CONCURRENCY) {
        if (compositeSignal.aborted) break;
        const batch = symbolRefs.slice(i, i + CONCURRENCY);

        const defResults = await Promise.allSettled(
          batch.map((sym) =>
            extensionClient.goToDefinition(
              filePath,
              sym.line,
              sym.column,
              compositeSignal,
            ),
          ),
        );

        // For each definition, fetch hover
        const hoverJobs: Array<Promise<{
          symIdx: number;
          defFile: string;
          hover: unknown;
        }> | null> = defResults.map((defResult, j) => {
          if (defResult.status !== "fulfilled" || !defResult.value) return null;
          const locs = defResult.value as Array<{
            file: string;
            line: number;
            column: number;
          }>;
          if (!Array.isArray(locs) || locs.length === 0) return null;
          const loc = locs[0];
          if (!loc) return null;
          return extensionClient
            .getHover(loc.file, loc.line, loc.column, compositeSignal)
            .then((hover) => ({ symIdx: j, defFile: loc.file, hover }))
            .catch(() => null) as Promise<{
            symIdx: number;
            defFile: string;
            hover: unknown;
          }>;
        });

        const validHoverJobs = hoverJobs.filter(
          (j): j is NonNullable<typeof j> => j !== null,
        );
        const hoverResults = await Promise.allSettled(validHoverJobs);

        // Map results back to symbols
        const hoverBySymIdx = new Map<
          number,
          { defFile: string; signature: string | null }
        >();
        for (const hr of hoverResults) {
          if (hr.status !== "fulfilled" || !hr.value) continue;
          const { symIdx, defFile, hover } = hr.value;
          const hoverContents = (hover as { contents?: unknown[] } | null)
            ?.contents;
          let signature: string | null = null;
          if (Array.isArray(hoverContents) && hoverContents.length > 0) {
            const raw = hoverContents.join("\n\n");
            signature = raw.slice(0, MAX_HOVER_CHARS);
          }
          hoverBySymIdx.set(symIdx, { defFile, signature });
        }

        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          if (!sym) continue;
          const hoverInfo = hoverBySymIdx.get(j);
          if (hoverInfo !== undefined) {
            resolved.push({
              name: sym.name,
              source: sym.specifier,
              signature: hoverInfo.signature,
              definitionFile: hoverInfo.defFile,
            });
          } else {
            resolved.push({
              name: sym.name,
              source: sym.specifier,
              signature: null,
              definitionFile: null,
            });
            unresolved.push(sym.name);
          }
        }
      }

      const resolvedCount = resolved.filter((r) => r.signature !== null).length;

      return successStructured({
        imports: resolved,
        count: resolved.length,
        resolved: resolvedCount,
        unresolved,
      });
    },
  };
}
