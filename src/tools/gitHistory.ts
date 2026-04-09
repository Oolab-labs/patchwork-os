import { isValidRef } from "./git-utils.js";
import {
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  successLarge,
  truncateOutput,
} from "./utils.js";

const MAX_OUTPUT_BYTES = 500 * 1024;

export function createGetCommitDetailsTool(workspace: string) {
  return {
    schema: {
      name: "getCommitDetails",
      description:
        "Get the full details of a git commit: author, date, commit message, changed files, " +
        "and optionally the complete diff patch. Use getGitLog to find commit hashes first.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["commitHash"],
        properties: {
          commitHash: {
            type: "string",
            description: "Full or abbreviated commit hash",
          },
          includePatch: {
            type: "boolean",
            description:
              "Include the full diff patch in the output. Default: true. " +
              "Set false to retrieve only metadata and file stats.",
          },
          filePath: {
            type: "string",
            description:
              "Optional absolute or workspace-relative file path to limit the diff output to a single file",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const hash = requireString(args, "commitHash", 64);
      if (!isValidRef(hash)) {
        return successLarge({ error: "Invalid commit hash" });
      }

      const includePatch = optionalBool(args, "includePatch") ?? true;
      const rawPath = optionalString(args, "filePath");
      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;

      // git show with a custom pretty format, then --stat for file summary
      // --format separates the header from the diff body
      const showArgs = ["show", "--format=fuller", "--stat"];
      if (!includePatch) showArgs.push("--no-patch");
      showArgs.push(hash);
      if (filterPath) showArgs.push("--", filterPath);

      const result = await execSafe("git", showArgs, {
        cwd: workspace,
        maxBuffer: MAX_OUTPUT_BYTES + 64 * 1024,
        signal,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim();
        if (msg.includes("unknown revision") || msg.includes("bad object")) {
          return successLarge({ error: `Commit "${hash}" not found` });
        }
        return successLarge({ error: msg || "git show failed" });
      }

      const { text, truncated } = truncateOutput(
        result.stdout,
        MAX_OUTPUT_BYTES,
      );
      return successLarge({
        output: text,
        ...(truncated ? { truncated: true } : {}),
      });
    },
  };
}

export function createGetDiffBetweenRefsTool(workspace: string) {
  return {
    schema: {
      name: "getDiffBetweenRefs",
      description:
        "Get the diff between two git refs (branches, tags, or commit hashes). " +
        "Use statOnly to get a quick file-level summary without the full patch.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["ref1", "ref2"],
        properties: {
          ref1: {
            type: "string",
            description: "The base ref (branch, tag, or commit hash)",
          },
          ref2: {
            type: "string",
            description: "The comparison ref (branch, tag, or commit hash)",
          },
          filePath: {
            type: "string",
            description:
              "Optional absolute or workspace-relative file path to limit the diff to a single file",
          },
          context: {
            type: "integer",
            description: "Number of context lines around changes. Default: 3",
          },
          statOnly: {
            type: "boolean",
            description:
              "Return only the file-level stat summary instead of the full patch. Default: false.",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const ref1 = requireString(args, "ref1", 256);
      const ref2 = requireString(args, "ref2", 256);

      if (!isValidRef(ref1)) return successLarge({ error: "Invalid ref1" });
      if (!isValidRef(ref2)) return successLarge({ error: "Invalid ref2" });

      const rawPath = optionalString(args, "filePath");
      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;
      const context = optionalInt(args, "context", 0, 100) ?? 3;
      const statOnly = optionalBool(args, "statOnly") ?? false;

      const diffArgs = ["diff"];
      if (statOnly) {
        diffArgs.push("--stat");
      } else {
        diffArgs.push(`-U${context}`);
      }
      diffArgs.push(`${ref1}..${ref2}`);
      if (filterPath) diffArgs.push("--", filterPath);

      const result = await execSafe("git", diffArgs, {
        cwd: workspace,
        maxBuffer: MAX_OUTPUT_BYTES + 64 * 1024,
        signal,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim();
        if (msg.includes("unknown revision") || msg.includes("bad object")) {
          return successLarge({
            error: `One or both refs not found: "${ref1}", "${ref2}"`,
          });
        }
        return successLarge({ error: msg || "git diff failed" });
      }

      const { text, truncated } = truncateOutput(
        result.stdout,
        MAX_OUTPUT_BYTES,
      );
      return successLarge({
        diff: text,
        ...(truncated ? { truncated: true } : {}),
      });
    },
  };
}
