import type { ProbeResults } from "../probe.js";
import {
  execSafe,
  makeRelative,
  optionalString,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createFindFilesTool(workspace: string, probes: ProbeResults) {
  return {
    schema: {
      name: "findFiles",
      description:
        "Find files by name/glob pattern in the workspace. Respects .gitignore.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern (e.g. '*.config.ts', 'README*')",
          },
          directory: {
            type: "string",
            description: "Subdirectory to search in (relative to workspace)",
          },
        },
        required: ["pattern"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const pattern = requireString(args, "pattern", 200);
      const directory = optionalString(args, "directory", 500);
      const searchDir = directory
        ? resolveFilePath(directory, workspace)
        : workspace;

      if (probes.fd) {
        const fdArgs = ["--glob", pattern, "--max-results", "100", searchDir];
        const result = await execSafe("fd", fdArgs, {
          timeout: 10000,
          signal,
        });
        const files = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((f) => makeRelative(f, workspace));
        return success({ files, total: files.length, tool: "fd" });
      }

      if (probes.git) {
        const result = await execSafe(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard"],
          { cwd: workspace, timeout: 10000, signal },
        );
        const allFiles = result.stdout.split("\n").filter(Boolean);
        // Convert glob to regex — escape metacharacters before glob substitution
        const regexPattern = pattern
          .replace(/\*\*/g, "\0GLOBSTAR\0")
          .replace(/\*/g, "\0STAR\0")
          .replace(/\?/g, "\0Q\0")
          .replace(/[.*+^${}()|[\]\\]/g, "\\$&")
          .replace(/\0GLOBSTAR\0/g, ".*")
          .replace(/\0STAR\0/g, "[^/]*")
          .replace(/\0Q\0/g, "[^/]");
        const regex = new RegExp(`(^|/)${regexPattern}$`, "i");
        const files = allFiles.filter((f) => regex.test(f)).slice(0, 100);
        return success({
          files,
          total: files.length,
          tool: "git-ls-files",
        });
      }

      // Fallback: find
      const findArgs = [
        searchDir,
        "-maxdepth",
        "10",
        "-name",
        pattern,
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
      ];
      const result = await execSafe("find", findArgs, {
        timeout: 10000,
        signal,
      });
      const files = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((f) => makeRelative(f, workspace))
        .slice(0, 100);
      return success({ files, total: files.length, tool: "find" });
    },
  };
}
