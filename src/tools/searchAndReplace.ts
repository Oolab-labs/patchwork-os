import fs from "node:fs";
import path from "node:path";
import { requireString, optionalString, resolveFilePath, execSafe, success, error } from "./utils.js";

const MAX_FILES = 100;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file

export function createSearchAndReplaceTool(workspace: string) {
  return {
    schema: {
      name: "searchAndReplace",
      description:
        "Find and replace text across all matching files in the workspace in a single operation. " +
        "More efficient than calling searchWorkspace + replaceBlock/editText per file. " +
        "Returns a summary of every file modified and the replacement count per file. " +
        "For exact string replacement, set isRegex: false (default). " +
        "For pattern-based replacement with capture groups, set isRegex: true. " +
        "Always dry-runs first internally to confirm matches exist before writing.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          pattern: {
            type: "string",
            description: "Text or regex pattern to search for",
          },
          replacement: {
            type: "string",
            description: "Replacement text. For regex mode, supports $1, $2, etc. capture group references.",
          },
          glob: {
            type: "string",
            description: "File glob pattern to limit scope (e.g. '**/*.ts', 'src/**/*.py'). Omit to search all text files.",
          },
          isRegex: {
            type: "boolean",
            description: "Treat pattern as a JavaScript regex. Default: false (literal string match).",
          },
          caseSensitive: {
            type: "boolean",
            description: "Case-sensitive match. Default: true.",
          },
          dryRun: {
            type: "boolean",
            description: "If true, returns what would change without writing any files. Useful for previewing impact. Default: false.",
          },
          includeIgnored: {
            type: "boolean",
            description: "Search inside .gitignored files (e.g. node_modules, build output). Default: false.",
          },
        },
        required: ["pattern", "replacement"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const pattern = requireString(args, "pattern");
      const replacement = requireString(args, "replacement", 65536);
      const glob = optionalString(args, "glob");
      const isRegex = (args.isRegex as boolean) ?? false;
      const caseSensitive = (args.caseSensitive as boolean) ?? true;
      const dryRun = (args.dryRun as boolean) ?? false;
      const includeIgnored = (args.includeIgnored as boolean) ?? false;

      if (pattern.length === 0) {
        return error("pattern must not be empty");
      }

      // Validate regex if requested
      if (isRegex) {
        try {
          new RegExp(pattern, caseSensitive ? "g" : "gi");
        } catch (e) {
          return error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Step 1: Find files containing the pattern via rg
      const rgArgs = ["--files-with-matches", "-l"];
      if (includeIgnored) rgArgs.push("--no-ignore-vcs");
      if (!caseSensitive) rgArgs.push("-i");
      if (isRegex) {
        rgArgs.push("-e", pattern);
      } else {
        rgArgs.push("-F", "-e", pattern);
      }
      if (glob) {
        rgArgs.push("--glob", glob);
      }
      rgArgs.push(workspace);

      const findResult = await execSafe("rg", rgArgs, {
        cwd: workspace,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      });

      const matchedFiles = findResult.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      if (matchedFiles.length === 0) {
        return success({
          matched: 0,
          modified: 0,
          dryRun,
          files: [],
          message: "No files contain the search pattern.",
        });
      }

      if (matchedFiles.length > MAX_FILES) {
        return error(
          `Pattern matches ${matchedFiles.length} files — exceeds safety limit of ${MAX_FILES}. ` +
          `Narrow the scope with the 'glob' parameter (e.g. 'src/**/*.ts') before proceeding.`,
        );
      }

      // Step 2: For each file, read, replace, and optionally write
      const regex = isRegex
        ? new RegExp(pattern, caseSensitive ? "gm" : "gim")
        : null;

      const results: Array<{
        file: string;
        replacements: number;
        written: boolean;
      }> = [];

      let totalReplacements = 0;

      for (const filePath of matchedFiles) {
        // Safety: only operate within workspace
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(workspace))) {
          continue;
        }

        let content: string;
        try {
          const stat = await fs.promises.stat(resolved);
          if (stat.size > MAX_FILE_SIZE) {
            results.push({ file: filePath, replacements: -1, written: false });
            continue;
          }
          content = await fs.promises.readFile(resolved, "utf-8");
        } catch {
          continue;
        }

        let newContent: string;
        let count = 0;

        if (regex) {
          // Reset lastIndex for global regex
          regex.lastIndex = 0;
          const matches = content.match(regex);
          count = matches ? matches.length : 0;
          newContent = content.replace(regex, replacement);
          regex.lastIndex = 0;
        } else {
          // Literal string replacement — count and replace
          const escapedForSplit = pattern;
          const parts = content.split(escapedForSplit);
          count = parts.length - 1;
          newContent = parts.join(replacement);
        }

        if (count === 0) continue;

        totalReplacements += count;

        if (!dryRun) {
          try {
            await fs.promises.writeFile(resolved, newContent, "utf-8");
            results.push({ file: filePath, replacements: count, written: true });
          } catch {
            results.push({ file: filePath, replacements: count, written: false });
          }
        } else {
          results.push({ file: filePath, replacements: count, written: false });
        }
      }

      return success({
        matched: matchedFiles.length,
        modified: results.filter((r) => r.written).length,
        totalReplacements,
        dryRun,
        files: results.map((r) => ({
          file: r.file,
          replacements: r.replacements === -1 ? "skipped (file too large)" : r.replacements,
          ...(dryRun ? {} : { written: r.written }),
        })),
      });
    },
  };
}
