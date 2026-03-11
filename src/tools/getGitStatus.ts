import { execSafe, optionalString, resolveFilePath, success } from "./utils.js";

export function createGetGitStatusTool(workspace: string) {
  return {
    schema: {
      name: "getGitStatus",
      description:
        "Get the current git status including branch, staged/unstaged/untracked files, and ahead/behind counts",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: {
            type: "string",
            description:
              "Optional absolute or workspace-relative file path to filter status for",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const rawPath = optionalString(args, "filePath");
      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;

      // Check if this is a git repo
      const checkGit = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (checkGit.exitCode !== 0) {
        return success({ available: false, error: "Not a git repository" });
      }

      // Get branch name
      const branchResult = await execSafe(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: workspace, signal },
      );
      const branch = branchResult.stdout.trim();

      // Get ahead/behind counts (ignore error if no upstream)
      let ahead = 0;
      let behind = 0;
      const revListResult = await execSafe(
        "git",
        ["rev-list", "--count", "--left-right", "HEAD...@{u}"],
        { cwd: workspace, signal },
      );
      if (revListResult.exitCode === 0) {
        const parts = revListResult.stdout.trim().split(/\s+/);
        ahead = Number.parseInt(parts[0] ?? "0", 10);
        behind = Number.parseInt(parts[1] ?? "0", 10);
      }

      // Get file status
      const statusArgs = ["status", "--porcelain=v1", "-u"];
      if (filterPath) {
        statusArgs.push("--", filterPath);
      }
      const statusResult = await execSafe("git", statusArgs, {
        cwd: workspace,
        signal,
      });

      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      const conflicts: string[] = [];

      for (const line of statusResult.stdout.split("\n")) {
        if (!line) continue;
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        const file = line.slice(3);

        // Conflict markers
        if (
          x === "U" ||
          y === "U" ||
          (x === "A" && y === "A") ||
          (x === "D" && y === "D")
        ) {
          conflicts.push(file);
          continue;
        }

        if (x === "?" && y === "?") {
          untracked.push(file);
          continue;
        }

        if (x !== " " && x !== "?") {
          staged.push(file);
        }
        if (y !== " " && y !== "?") {
          unstaged.push(file);
        }
      }

      return success({
        branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicts,
      });
    },
  };
}
