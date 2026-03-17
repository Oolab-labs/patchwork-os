import fs from "node:fs";
import { resolveCommandPath } from "../probe.js";
import {
  error,
  execSafe,
  optionalBool,
  optionalString,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

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
            description:
              "Replacement text. For regex mode, supports $1, $2, etc. capture group references.",
          },
          glob: {
            type: "string",
            description:
              "File glob pattern to limit scope (e.g. '**/*.ts', 'src/**/*.py'). Omit to search all text files.",
          },
          isRegex: {
            type: "boolean",
            description:
              "Treat pattern as a JavaScript regex. Default: false (literal string match).",
          },
          caseSensitive: {
            type: "boolean",
            description: "Case-sensitive match. Default: true.",
          },
          dryRun: {
            type: "boolean",
            description:
              "If true, returns what would change without writing any files. Useful for previewing impact. Default: false.",
          },
          includeIgnored: {
            type: "boolean",
            description:
              "Search inside .gitignored files (e.g. node_modules, build output). Default: false.",
          },
        },
        required: ["pattern", "replacement"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const pattern = requireString(args, "pattern");
      const replacement = requireString(args, "replacement", 65536);
      const glob = optionalString(args, "glob");
      const isRegex = optionalBool(args, "isRegex") ?? false;
      const caseSensitive = optionalBool(args, "caseSensitive") ?? true;
      const dryRun = optionalBool(args, "dryRun") ?? false;
      const includeIgnored = optionalBool(args, "includeIgnored") ?? false;

      if (pattern.length === 0) {
        return error("pattern must not be empty");
      }
      // A null byte terminates the rg -e argument at the OS level, causing rg to
      // match every line while the JS replacement finds nothing — misleading output.
      if (pattern.includes("\x00")) {
        return error("pattern must not contain a null byte");
      }
      // Compile regex once (used for both counting matches and replacement)
      let regex: RegExp | null = null;
      if (isRegex) {
        try {
          regex = new RegExp(pattern, caseSensitive ? "gm" : "gim");
        } catch (e) {
          return error(
            `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
          );
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
        // Reject glob values starting with '-' — rg may interpret them as flags
        // (e.g. '--no-ignore-vcs' would disable VCS ignore rules silently).
        if (glob.startsWith("-")) {
          return error(
            `Invalid glob pattern "${glob}": must not start with '-'`,
          );
        }
        // rg applies --glob relative to the search root. A bare pattern like
        // '*.ts' only matches files at the root level; 'src/*.ts' matches one
        // level deep. Prepend '**/' when the glob contains no path separator so
        // that '*.ts' becomes '**/*.ts' and matches files in any subdirectory —
        // which is what every caller expects.
        // Handle negation globs ('!*.ts') by prepending after the '!'.
        const isNegation = glob.startsWith("!");
        const rawPattern = isNegation ? glob.slice(1) : glob;
        const needsPrefix = !rawPattern.includes("/") && !rawPattern.startsWith("**/");
        const normalizedGlob = needsPrefix
          ? `${isNegation ? "!" : ""}**/${rawPattern}`
          : glob;
        rgArgs.push("--glob", normalizedGlob);
      }
      rgArgs.push(workspace);

      const findResult = await execSafe(resolveCommandPath("rg", workspace), rgArgs, {
        cwd: workspace,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        signal,
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
          `Pattern matches ${matchedFiles.length} files — exceeds safety limit of ${MAX_FILES}. Narrow the scope with the 'glob' parameter (e.g. 'src/**/*.ts') before proceeding.`,
        );
      }

      // Step 2: For each file, read, replace, and optionally write
      // Process files in parallel batches (bounded concurrency to avoid fd exhaustion)
      const CONCURRENCY = 10;

      type FileResult = {
        file: string;
        replacements: number | "skipped (file too large)";
        written: boolean;
        writeError?: string;
      };

      const processFile = async (
        filePath: string,
        fileSignal?: AbortSignal,
      ): Promise<FileResult | null> => {
        // Safety: only operate within workspace. Use the validated real path for
        // all subsequent fs operations — do NOT call path.resolve(filePath) again,
        // as that would bypass the symlink resolution done inside resolveFilePath.
        let resolved: string;
        try {
          resolved = resolveFilePath(filePath, workspace, { write: true });
        } catch {
          return null;
        }

        let content: string;
        try {
          const stat = await fs.promises.stat(resolved);
          if (stat.size > MAX_FILE_SIZE) {
            return {
              file: filePath,
              replacements: "skipped (file too large)",
              written: false,
            };
          }
          content = await fs.promises.readFile(resolved, {
            encoding: "utf-8",
            signal: fileSignal,
          });
        } catch {
          return null;
        }

        let newContent: string;
        let count = 0;

        if (regex) {
          // Create a fresh RegExp per file — the shared `regex` object has the `g`
          // flag, and `.lastIndex` is mutable state. Concurrent `processFile` calls
          // inside `Promise.all` would race on that single object across `await`
          // boundaries, producing incorrect match counts or wrong replacements.
          const localRegex = new RegExp(regex.source, regex.flags);
          const matches = content.match(localRegex);
          count = matches ? matches.length : 0;
          newContent = content.replace(localRegex, replacement);
        } else {
          const parts = content.split(pattern);
          count = parts.length - 1;
          newContent = parts.join(replacement);
        }

        if (count === 0) return null;

        if (!dryRun) {
          try {
            await fs.promises.writeFile(resolved, newContent, {
              encoding: "utf-8",
              signal: fileSignal,
            });
            return { file: filePath, replacements: count, written: true };
          } catch (err) {
            return {
              file: filePath,
              replacements: count,
              written: false,
              writeError: err instanceof Error ? err.message : String(err),
            };
          }
        }
        return { file: filePath, replacements: count, written: false };
      };

      const results: FileResult[] = [];
      for (let i = 0; i < matchedFiles.length; i += CONCURRENCY) {
        if (signal?.aborted) break;
        const batch = matchedFiles.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((f) => processFile(f, signal)),
        );
        for (const r of batchResults) {
          if (r !== null) results.push(r);
        }
      }

      const totalReplacements = results.reduce(
        (sum, r) =>
          sum + (typeof r.replacements === "number" ? r.replacements : 0),
        0,
      );
      const writtenCount = results.filter((r) => r.written).length;
      const failedCount = results.filter(
        (r) =>
          !dryRun &&
          !r.written &&
          typeof r.replacements === "number" &&
          r.replacements > 0,
      ).length;

      return success({
        matched: matchedFiles.length,
        modified: writtenCount,
        totalReplacements,
        dryRun,
        ...(failedCount > 0 && {
          warning: `${writtenCount} file(s) written, ${failedCount} file(s) failed to write — check per-file results`,
        }),
        files: results.map((r) => ({
          file: r.file,
          replacements: r.replacements,
          ...(dryRun ? {} : { written: r.written }),
          ...(r.writeError && { writeError: r.writeError }),
        })),
      });
    },
  };
}
