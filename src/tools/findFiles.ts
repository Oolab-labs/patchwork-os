import type { ProbeResults } from "../probe.js";
import {
  error,
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
        const truncated = files.length === 100;
        return success({
          files,
          count: files.length,
          tool: "fd",
          ...(truncated
            ? {
                truncated: true,
                note: "Result limit reached — narrow pattern or use directory",
              }
            : {}),
        });
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
        const allMatches = allFiles.filter((f) => regex.test(f));
        const files = allMatches.slice(0, 100);
        return success({
          files,
          count: files.length,
          totalMatches: allMatches.length,
          tool: "git-ls-files",
          ...(files.length < allMatches.length
            ? {
                truncated: true,
                note: "Result limit reached — narrow pattern or use directory",
              }
            : {}),
        });
      }

      // Fallback: find
      // Guard: a pattern starting with `-` would be interpreted by `find` as a
      // primary or option (e.g. `-maxdepth 0`, `-exec …`) rather than a name pattern.
      if (pattern.startsWith("-")) {
        return error(
          `Pattern must not start with "-" (would be interpreted as a find option)`,
        );
      }
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
        "-not",
        "-path",
        "*/.jj/*",
        "-not",
        "-path",
        "*/.sl/*",
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
      const truncated = files.length === 100;
      return success({
        files,
        count: files.length,
        tool: "find",
        ...(truncated
          ? {
              truncated: true,
              note: "Result limit reached — narrow pattern or use directory",
            }
          : {}),
      });
    },
  };
}
