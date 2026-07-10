import {
  execSafe,
  optionalString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createGetGitStatusTool(workspace: string) {
  return {
    schema: {
      name: "getGitStatus",
      description:
        "Git status: branch, staged/unstaged/untracked files, ahead/behind counts.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: {
            type: "string",
            description:
              "Filter status to a single file (absolute or workspace-relative)",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          branch: { type: "string" },
          ahead: { type: "integer" },
          behind: { type: "integer" },
          staged: { type: "array", items: { type: "string" } },
          unstaged: { type: "array", items: { type: "string" } },
          untracked: { type: "array", items: { type: "string" } },
          conflicts: { type: "array", items: { type: "string" } },
          error: { type: "string" },
        },
        required: ["available"],
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const rawPath = optionalString(args, "filePath");
      const filterPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;

      // One subprocess instead of four (git-dir check, branch name,
      // ahead/behind, file status): --branch adds the "# branch.*" header
      // lines (repo check + branch name + ahead/behind all fold in), and
      // --porcelain=v2 gives everything --porcelain=v1 gave for files, in a
      // slightly different (but equally parseable) column layout.
      const statusArgs = ["status", "--porcelain=v2", "--branch", "-u"];
      if (filterPath) {
        statusArgs.push("--", filterPath);
      }
      const statusResult = await execSafe("git", statusArgs, {
        cwd: workspace,
        signal,
      });
      if (statusResult.exitCode !== 0) {
        return successStructured({
          available: false,
          error: "Not a git repository",
        });
      }

      let branch = "";
      let ahead = 0;
      let behind = 0;
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      const conflicts: string[] = [];

      for (const line of statusResult.stdout.split("\n")) {
        if (!line) continue;

        if (line.startsWith("# branch.head ")) {
          const head = line.slice("# branch.head ".length).trim();
          // Detached HEAD reports "(detached)" in v2 headers; match the old
          // `git rev-parse --abbrev-ref HEAD` contract of plain "HEAD".
          branch = head === "(detached)" ? "HEAD" : head;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const parts = line.slice("# branch.ab ".length).trim().split(/\s+/);
          ahead = Number.parseInt(parts[0]?.replace("+", "") ?? "0", 10);
          behind = Number.parseInt(parts[1]?.replace("-", "") ?? "0", 10);
          continue;
        }
        if (line.startsWith("#")) continue; // branch.oid / branch.upstream — unused

        // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
        // Rename/copy entry:      "2 XY sub mH mI mW hH hI Xscore path\torigPath"
        // Unmerged (conflict):    "u XY sub m1 m2 m3 mW h1 h2 h3 path"
        // Untracked:              "? path"
        const kind = line[0];
        if (kind === "?") {
          untracked.push(line.slice(2));
          continue;
        }
        if (kind === "u") {
          const fields = line.split(" ");
          conflicts.push(fields.slice(10).join(" "));
          continue;
        }
        if (kind === "1" || kind === "2") {
          const fields = line.split(" ");
          const xy = fields[1] ?? "..";
          const x = xy[0] ?? ".";
          const y = xy[1] ?? ".";
          // "1" entries have 9 leading fields before the path; "2" (rename/
          // copy) entries have one more (the score field) and append
          // "path\torigPath" — take the renamed-to path, which comes first.
          const pathField = fields.slice(kind === "2" ? 9 : 8).join(" ");
          const file = pathField.includes("\t")
            ? (pathField.split("\t")[0] ?? pathField)
            : pathField;

          if (x !== ".") staged.push(file);
          if (y !== ".") unstaged.push(file);
        }
      }

      const GIT_STATUS_MAX_FILES = 500;
      const capList = (arr: string[]): { files: string[]; truncated?: true } =>
        arr.length > GIT_STATUS_MAX_FILES
          ? { files: arr.slice(0, GIT_STATUS_MAX_FILES), truncated: true }
          : { files: arr };

      const sc = capList(staged);
      const uc = capList(unstaged);
      const tc = capList(untracked);
      const cc = capList(conflicts);

      return successStructured({
        available: true,
        branch,
        ahead,
        behind,
        staged: sc.files,
        unstaged: uc.files,
        untracked: tc.files,
        conflicts: cc.files,
        ...(sc.truncated && { stagedTruncated: true }),
        ...(uc.truncated && { unstagedTruncated: true }),
        ...(tc.truncated && { untrackedTruncated: true }),
        ...(cc.truncated && { conflictsTruncated: true }),
      });
    },
  };
}
