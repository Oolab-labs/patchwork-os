import fs from "node:fs";
import type { ExtensionClient } from "../extensionClient.js";
import {
  error,
  execSafe,
  languageIdFromPath,
  requireString,
  resolveFilePath,
  success,
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
        "List all symbols (functions, classes, interfaces, types, methods, etc.) defined in a file. " +
        "Returns a flat list with names, kinds, line numbers, and parent relationships. " +
        "Use this to understand a file's structure before editing, or to find where a specific symbol is defined. " +
        "When the VS Code extension is connected, uses full LSP symbol data including nested symbols. " +
        "Without the extension, falls back to regex-based detection for common languages.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);

      // Extension path: full LSP document symbols
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.getDocumentSymbols(filePath);
          if (result !== null && typeof result === "object") {
            const r = result as Record<string, unknown>;
            return success({ ...r, source: "lsp" });
          }
          // null means LSP not ready for this file — fall through to grep
        } catch {
          // fall through
        }
      }

      // Grep fallback: regex-based symbol detection
      const langId = languageIdFromPath(filePath);
      const pattern = SYMBOL_PATTERNS[langId];

      if (!pattern) {
        // No pattern — just return empty with a note
        return success({
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
        return success({ symbols: [], count: 0, source: "grep-fallback" });
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
        const lineNum = Number.parseInt(m[1]!, 10);
        const text = m[2]!.trim();

        // Extract symbol name and kind from the matched line
        const symMatch = text.match(
          /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub\s+(?:\(.*?\)\s+)?)?(?:async\s+)?(class|interface|type|enum|function|const|let|var|fn|struct|trait|impl|mod|def|type)\s+(\w+)/,
        );
        if (!symMatch) continue;

        const kindRaw = symMatch[1]!;
        const name = symMatch[2]!;
        const kind = kindToSymbolKind(kindRaw);

        symbols.push({ name, kind, line: lineNum, parent: null });
      }

      return success({
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
