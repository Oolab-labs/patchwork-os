import {
  execSafe,
  optionalInt,
  optionalString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createGetGitLogTool(workspace: string) {
  return {
    schema: {
      name: "getGitLog",
      description:
        "Get recent git log entries for the workspace or a specific file",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          maxEntries: {
            type: "integer",
            description:
              "Maximum number of log entries to return. Default: 20, max: 100",
          },
          filePath: {
            type: "string",
            description: "Optional file path to filter log for",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const maxEntries = optionalInt(args, "maxEntries", 1, 100) ?? 20;
      const rawPath = optionalString(args, "filePath");
      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;

      const logArgs = [
        "log",
        "--format=%H %ae %aI %s",
        "--no-merges",
        `-${maxEntries}`,
      ];
      if (filterPath) {
        logArgs.push("--", filterPath);
      }

      const result = await execSafe("git", logArgs, {
        cwd: workspace,
        signal,
      });

      if (result.exitCode !== 0) {
        return success({ error: result.stderr.trim() || "git log failed" });
      }

      const entries = [];
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        // Format: <hash> <email> <date> <subject...>
        const match = line.match(/^(\S+) (\S+) (\S+) (.+)$/);
        if (match) {
          entries.push({
            hash: match[1],
            author: match[2],
            date: match[3],
            subject: match[4],
          });
        }
      }

      return success({ entries });
    },
  };
}
