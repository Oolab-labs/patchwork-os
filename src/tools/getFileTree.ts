import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../probe.js";
import {
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  resolveFilePath,
  success,
} from "./utils.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "__pycache__",
  ".next",
  ".nuxt",
  "build",
  "coverage",
  ".cache",
]);
const MAX_ENTRIES = 2000;

export function createGetFileTreeTool(workspace: string, probes: ProbeResults) {
  return {
    schema: {
      name: "getFileTree",
      description:
        "List files and directories in the workspace tree. Respects .gitignore when available.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          directory: {
            type: "string",
            description:
              "Subdirectory to list (relative to workspace, default: root)",
          },
          maxDepth: {
            type: "integer",
            description: "Maximum directory depth (default: 3, max: 10)",
            minimum: 1,
            maximum: 10,
          },
          includeHidden: {
            type: "boolean",
            description: "Include hidden files/dirs (default: false)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const directory = optionalString(args, "directory", 500);
      const maxDepth = optionalInt(args, "maxDepth", 1, 10) ?? 3;
      const includeHidden = optionalBool(args, "includeHidden") ?? false;

      const targetDir = directory
        ? resolveFilePath(directory, workspace)
        : workspace;

      if (probes.git) {
        const result = await execSafe(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard"],
          { cwd: workspace, timeout: 10000, signal },
        );
        if (result.exitCode === 0) {
          let entries = result.stdout.split("\n").filter(Boolean);
          // Filter by target directory
          if (directory) {
            entries = entries.filter(
              (e) => e.startsWith(`${directory}/`) || e.startsWith(directory),
            );
          }
          if (!includeHidden) {
            entries = entries.filter(
              (e) => !e.split("/").some((p) => p.startsWith(".") && p !== "."),
            );
          }
          // Apply depth limit
          const relBase = directory || "";
          entries = entries.filter((e) => {
            const rel = relBase ? e.slice(relBase.length + 1) : e;
            return rel.split("/").length <= maxDepth;
          });
          entries = entries.slice(0, MAX_ENTRIES);
          return success({
            entries,
            total: entries.length,
            truncated: entries.length >= MAX_ENTRIES,
            tool: "git",
          });
        }
      }

      // Fallback: async fs.readdir
      const entries: string[] = [];
      async function walk(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth || entries.length >= MAX_ENTRIES) return;
        let items: fs.Dirent[];
        try {
          items = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (entries.length >= MAX_ENTRIES) break;
          if (!includeHidden && item.name.startsWith(".")) continue;
          if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
          const rel = path.relative(workspace, path.join(dir, item.name));
          entries.push(item.isDirectory() ? `${rel}/` : rel);
          if (item.isDirectory()) await walk(path.join(dir, item.name), depth + 1);
        }
      }
      await walk(targetDir, 1);
      return success({
        entries,
        total: entries.length,
        truncated: entries.length >= MAX_ENTRIES,
        tool: "fs",
      });
    },
  };
}
