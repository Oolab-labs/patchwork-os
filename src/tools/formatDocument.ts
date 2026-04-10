import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import type { ProgressFn } from "../transport.js";
import {
  error,
  execSafe,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

interface FormatterOption {
  cmd: string;
  args: (filePath: string) => string[];
  probe: keyof ProbeResults;
}

const JS_FORMATTERS: FormatterOption[] = [
  { cmd: "prettier", args: (f) => ["--write", f], probe: "prettier" },
  { cmd: "biome", args: (f) => ["format", "--write", f], probe: "biome" },
];

const PY_FORMATTERS: FormatterOption[] = [
  { cmd: "black", args: (f) => [f], probe: "black" },
  { cmd: "ruff", args: (f) => ["format", f], probe: "ruff" },
];

const GO_FORMATTERS: FormatterOption[] = [
  { cmd: "gofmt", args: (f) => ["-w", f], probe: "gofmt" },
];

const RS_FORMATTERS: FormatterOption[] = [
  { cmd: "rustfmt", args: (f) => [f], probe: "rustfmt" },
];

const EXT_FORMATTERS: Record<string, FormatterOption[]> = {
  ".ts": JS_FORMATTERS,
  ".tsx": JS_FORMATTERS,
  ".js": JS_FORMATTERS,
  ".jsx": JS_FORMATTERS,
  ".py": PY_FORMATTERS,
  ".go": GO_FORMATTERS,
  ".rs": RS_FORMATTERS,
};

export function createFormatDocumentTool(
  workspace: string,
  probes: ProbeResults,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "formatDocument",
      description:
        "Format a file using VS Code's configured formatter, or falls back to CLI formatters (prettier, biome, black, gofmt, rustfmt). Returns whether changes were made.",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to format (relative to workspace or absolute)",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          formatted: { type: "boolean" },
          source: { type: "string" },
          changes: { type: "string" },
          formatterUsed: { type: "string" },
          linesBeforeCount: { type: "integer" },
          linesAfterCount: { type: "integer" },
        },
        required: ["formatted"],
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: ProgressFn,
    ) => {
      progress?.(0, 100);
      const rawPath = requireString(args, "filePath");
      const resolved = resolveFilePath(rawPath, workspace, { write: true });

      // Read file content before formatting
      let contentBefore: string;
      try {
        contentBefore = fs.readFileSync(resolved, "utf-8");
      } catch {
        return error({ error: `File not found: ${rawPath}` });
      }

      // Try extension first
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.formatDocument(resolved);
          if (result !== null) {
            // Read file content after formatting
            const contentAfter = fs.readFileSync(resolved, "utf-8");
            if (contentBefore === contentAfter) {
              return successStructured({
                formatted: true,
                source: "extension",
                changes: "none",
              });
            }
            return successStructured({
              formatted: true,
              source: "extension",
              changes: "modified",
              linesBeforeCount: contentBefore.split("\n").length,
              linesAfterCount: contentAfter.split("\n").length,
            });
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to CLI fallback
        }
      }

      // CLI fallback
      const ext = path.extname(resolved).toLowerCase();
      const candidates = EXT_FORMATTERS[ext];
      if (!candidates || candidates.length === 0) {
        return error({
          formatted: false,
          source: "cli",
          error: `No formatter configured for extension "${ext}"`,
        });
      }

      const formatter = candidates.find((f) => probes[f.probe]);
      if (!formatter) {
        const names = candidates.map((f) => f.cmd).join(", ");
        return error({
          formatted: false,
          source: "cli",
          error: `No available formatter found. Tried: ${names}`,
        });
      }

      const result = await execSafe(formatter.cmd, formatter.args(resolved), {
        cwd: workspace,
        timeout: 30_000,
        signal,
      });

      if (result.exitCode !== 0) {
        return error({
          formatted: false,
          source: "cli",
          formatterUsed: formatter.cmd,
          error: result.stderr,
        });
      }

      const contentAfter = fs.readFileSync(resolved, "utf-8");
      progress?.(100, 100);
      return successStructured({
        formatted: true,
        source: "cli",
        formatterUsed: formatter.cmd,
        changes: contentBefore === contentAfter ? "none" : "modified",
        linesBeforeCount: contentBefore.split("\n").length,
        linesAfterCount: contentAfter.split("\n").length,
      });
    },
  };
}
