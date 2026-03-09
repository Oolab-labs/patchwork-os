import {
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  resolveFilePath,
  success,
  truncateOutput,
} from "./utils.js";

const MAX_DIFF_BYTES = 500 * 1024;

export function createGetGitDiffTool(workspace: string) {
  return {
    schema: {
      name: "getGitDiff",
      description:
        "Get the git diff output for the workspace or a specific file",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: {
            type: "string",
            description: "Optional file path to diff",
          },
          staged: {
            type: "boolean",
            description:
              "If true, show staged (cached) changes. Default: false",
          },
          context: {
            type: "integer",
            description: "Number of context lines around changes. Default: 3",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const rawPath = optionalString(args, "filePath");
      const staged = optionalBool(args, "staged") ?? false;
      const context = optionalInt(args, "context", 0, 100) ?? 3;

      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;

      const diffArgs = ["diff"];
      if (staged) {
        diffArgs.push("--cached");
      }
      diffArgs.push(`-U${context}`);
      if (filterPath) {
        diffArgs.push("--", filterPath);
      }

      const result = await execSafe("git", diffArgs, {
        cwd: workspace,
        maxBuffer: MAX_DIFF_BYTES + 64 * 1024,
        signal,
      });

      if (result.exitCode !== 0) {
        return success({ error: result.stderr.trim() || "git diff failed" });
      }

      const { text, truncated } = truncateOutput(result.stdout, MAX_DIFF_BYTES);
      return success({ diff: text, truncated });
    },
  };
}
