import fs from "node:fs";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  execSafe,
  languageIdFromPath,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

// Language-specific patterns to detect symbol definitions (grep fallback)
const SYMBOL_PATTERNS: Record<string, string> = {
  typescript: String.raw`^\s*(export\s+)?(default\s+)?(abstract\s+)?(class|interface|type|enum|function|async\s+function|const|let|var)\s+\w`,
  typescriptreact: String.raw`^\s*(export\s+)?(default\s+)?(abstract\s+)?(class|interface|type|enum|function|async\s+function|const|let|var)\s+\w`,
  javascript: String.raw`^\s*(export\s+)?(default\s+)?(class|function|async\s+function|const|let|var)\s+\w`,
  javascriptreact: String.raw`^\s*(export\s+)?(default\s+)?(class|function|async\s+function|const|let|var)\s+\w`,
  python: String.raw`^\s*(class|def|async\s+def)\s+\w`,
  rust: String.raw`^\s*(pub\s+)?(pub\s*\(.*\)\s+)?(fn|struct|enum|trait|impl|type|mod|const|static)\s+\w`,
  go: String.raw`^(func|type|var|const)\s+\w`,
};

export function createGetDocumentSymbolsTool(
  workspace: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "getDocumentSymbols",
      description:
        "List symbols (fns, classes, interfaces, methods) in a file: names, kinds, lines, parents.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Workspace or absolute path to the file",
          },
          kind: {
            description:
              "Filter to one or more symbol kinds (e.g. ['Class','Function','Method','Interface']). Case-insensitive. Cuts variable noise on large bundled files.",
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          maxDepth: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "Max nesting depth to include (0=top-level only, 1=top + immediate children, …). Default: no depth filter. LSP returns a flattened list keyed by 'parent' name; depth is computed by walking the parent chain.",
          },
          topN: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description:
              "Cap returned symbols. Default 500. Combined with kind/maxDepth filters which apply first.",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                parent: { type: ["string", "null"] },
              },
              required: ["name", "kind", "line"],
            },
          },
          count: { type: "integer" },
          source: {
            type: "string",
            enum: ["lsp", "grep-fallback", "unavailable"],
          },
          note: { type: "string" },
        },
        required: ["symbols", "count", "source"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);

      const kindArg = args.kind;
      const kindFilter: Set<string> | null = (() => {
        if (typeof kindArg === "string")
          return new Set([kindArg.toLowerCase()]);
        if (Array.isArray(kindArg)) {
          return new Set(
            kindArg
              .filter((k): k is string => typeof k === "string")
              .map((k) => k.toLowerCase()),
          );
        }
        return null;
      })();
      const maxDepth =
        typeof args.maxDepth === "number" && Number.isFinite(args.maxDepth)
          ? Math.max(0, Math.floor(args.maxDepth))
          : null;
      const topN =
        typeof args.topN === "number" && Number.isFinite(args.topN)
          ? Math.max(1, Math.floor(args.topN))
          : 500;

      // Extension path: full LSP document symbols
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.getDocumentSymbols(
            filePath,
            signal,
          );
          if (result !== null && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (Array.isArray(r.symbols)) {
              type Sym = {
                name?: string;
                kind?: string;
                parent?: string | null;
              };
              const all = r.symbols as Sym[];
              const totalCount = all.length;

              // Build parent-depth map by walking the parent chain. LSP
              // returns a flattened list with `parent: <name|null>`; depth
              // is the chain length to a null parent.
              const byName = new Map<string, Sym>();
              for (const s of all) {
                if (typeof s.name === "string") byName.set(s.name, s);
              }
              const depthOf = (s: Sym): number => {
                let d = 0;
                let cur: Sym | undefined = s;
                while (cur && typeof cur.parent === "string") {
                  d += 1;
                  if (d > 32) break; // cycle guard
                  cur = byName.get(cur.parent);
                }
                return d;
              };

              const filtered = all.filter((s) => {
                if (
                  kindFilter &&
                  typeof s.kind === "string" &&
                  !kindFilter.has(s.kind.toLowerCase())
                ) {
                  return false;
                }
                if (maxDepth !== null && depthOf(s) > maxDepth) return false;
                return true;
              });

              const truncated = filtered.length > topN;
              const symbols = truncated ? filtered.slice(0, topN) : filtered;

              return successStructured({
                ...r,
                symbols,
                source: "lsp",
                ...(truncated || filtered.length !== totalCount
                  ? { truncated: true, totalCount }
                  : {}),
              });
            }
            return successStructured({ ...r, source: "lsp" });
          }
          // null means LSP not ready for this file — fall through to grep
        } catch (err) {
          if (err instanceof ExtensionTimeoutError) {
            return error(
              "Language server timed out getting document symbols — it may still be indexing. " +
                "Wait a few seconds and try again, or use the grep-based fallback by disconnecting the extension.",
            );
          }
          // other errors (disconnect mid-call) — fall through to grep
        }
      }

      // Grep fallback: regex-based symbol detection
      const langId = languageIdFromPath(filePath);
      const pattern = SYMBOL_PATTERNS[langId];

      if (!pattern) {
        // No pattern — just return empty with a note
        return successStructured({
          symbols: [],
          count: 0,
          source: "unavailable",
          note: `No symbol patterns available for language '${langId}'. Connect the VS Code extension for LSP-based symbols.`,
        });
      }

      if (!fs.existsSync(filePath)) {
        return error(`File not found: ${filePath}`);
      }

      const rgResult = await execSafe(
        "rg",
        ["-n", "--no-heading", "-e", pattern, filePath],
        {
          cwd: workspace,
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        },
      );

      if (!rgResult.stdout.trim()) {
        return successStructured({
          symbols: [],
          count: 0,
          source: "grep-fallback",
        });
      }

      const symbols: Array<{
        name: string;
        kind: string;
        line: number;
        parent: null;
      }> = [];

      for (const line of rgResult.stdout.split("\n")) {
        if (!line) continue;
        const m = line.match(/^(\d+):(.*)$/);
        if (!m) continue;
        const lineNum = Number.parseInt(m[1] ?? "0", 10);
        const text = (m[2] ?? "").trim();

        // Extract symbol name and kind from the matched line
        const symMatch = text.match(
          /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub\s+(?:\(.*?\)\s+)?)?(?:async\s+)?(class|interface|type|enum|function|const|let|var|fn|struct|trait|impl|mod|def|type)\s+(\w+)/,
        );
        if (!symMatch) continue;

        const kindRaw = symMatch[1] ?? "";
        const name = symMatch[2] ?? "";
        const kind = kindToSymbolKind(kindRaw);

        symbols.push({ name, kind, line: lineNum, parent: null });
      }

      return successStructured({
        symbols,
        count: symbols.length,
        source: "grep-fallback",
      });
    },
  };
}

function kindToSymbolKind(raw: string): string {
  switch (raw) {
    case "class":
      return "Class";
    case "interface":
      return "Interface";
    case "type":
      return "TypeParameter";
    case "enum":
      return "Enum";
    case "function":
    case "fn":
    case "def":
      return "Function";
    case "const":
      return "Constant";
    case "let":
    case "var":
      return "Variable";
    case "struct":
      return "Struct";
    case "trait":
      return "Interface";
    case "impl":
      return "Class";
    case "mod":
    case "module":
      return "Module";
    default:
      return "Variable";
  }
}
