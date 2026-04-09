import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import {
  error,
  execSafe,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

interface FixerOption {
  cmd: string;
  args: (filePath: string) => string[];
  probe: keyof ProbeResults;
}

const JS_FIXERS: FixerOption[] = [
  { cmd: "eslint", args: (f) => ["--fix", f], probe: "eslint" },
  { cmd: "biome", args: (f) => ["check", "--write", f], probe: "biome" },
];

const PY_FIXERS: FixerOption[] = [
  { cmd: "ruff", args: (f) => ["check", "--fix", f], probe: "ruff" },
];

const EXT_FIXERS: Record<string, FixerOption[]> = {
  ".ts": JS_FIXERS,
  ".tsx": JS_FIXERS,
  ".js": JS_FIXERS,
  ".jsx": JS_FIXERS,
  ".py": PY_FIXERS,
};

export function createFixAllLintErrorsTool(
  workspace: string,
  probes: ProbeResults,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "fixAllLintErrors",
      description:
        "Auto-fix all lint errors in a file. Uses VS Code's source.fixAll when connected, or falls back to CLI tools (eslint --fix, biome, ruff --fix). Returns a summary of changes.",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to fix (relative to workspace or absolute)",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const resolved = resolveFilePath(rawPath, workspace, { write: true });

      let contentBefore: string;
      try {
        contentBefore = fs.readFileSync(resolved, "utf-8");
      } catch {
        return error({ error: `File not found: ${rawPath}` });
      }

      // Try extension first
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.fixAllLintErrors(resolved);
          if (result !== null) {
            const contentAfter = fs.readFileSync(resolved, "utf-8");
            return success({
              fixed: true,
              source: "extension",
              changes: contentBefore === contentAfter ? "none" : "modified",
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
      const candidates = EXT_FIXERS[ext];
      if (!candidates || candidates.length === 0) {
        return error({
          fixed: false,
          source: "cli",
          error: `No lint fixer configured for extension "${ext}"`,
        });
      }

      const fixer = candidates.find((f) => probes[f.probe]);
      if (!fixer) {
        const names = candidates.map((f) => f.cmd).join(", ");
        return error({
          fixed: false,
          source: "cli",
          error: `No available lint fixer found. Tried: ${names}`,
        });
      }

      const result = await execSafe(fixer.cmd, fixer.args(resolved), {
        cwd: workspace,
        timeout: 30_000,
        signal,
      });

      if (result.exitCode !== 0) {
        return error({
          fixed: false,
          source: "cli",
          fixerUsed: fixer.cmd,
          error: result.stderr,
        });
      }

      const contentAfter = fs.readFileSync(resolved, "utf-8");
      return success({
        fixed: true,
        source: "cli",
        fixerUsed: fixer.cmd,
        changes: contentBefore === contentAfter ? "none" : "modified",
        linesBeforeCount: contentBefore.split("\n").length,
        linesAfterCount: contentAfter.split("\n").length,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  };
}
