import { checkGitRepo, isValidRef, runGit } from "./git-utils.js";
import {
  error,
  execSafe,
  optionalBool,
  optionalString,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

async function currentBranch(
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const r = await execSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspace,
    signal,
  });
  return r.stdout.trim();
}

// Validate that all provided paths stay within the workspace.
// Uses resolveFilePath which also resolves symlinks (preventing symlink-based escapes).
function validatePaths(files: string[], workspace: string): string | null {
  for (const f of files) {
    try {
      resolveFilePath(f, workspace);
    } catch (err) {
      return err instanceof Error
        ? err.message
        : `Path escapes workspace: ${f}`;
    }
  }
  return null;
}

export function createGitAddTool(workspace: string) {
  return {
    schema: {
      name: "gitAdd",
      description:
        "Stage files for the next git commit. Omit files to stage all tracked changes (git add -u). " +
        "Use addUntracked: true to also stage new untracked files. Check first with getGitStatus.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "File paths to stage (absolute or workspace-relative). If omitted, stages all modified tracked files.",
          },
          addUntracked: {
            type: "boolean",
            description: "Also stage new untracked files. Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          staged: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
        },
        required: ["staged", "count"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const rawFiles = args.files;
      const addUntracked = optionalBool(args, "addUntracked") ?? false;

      let addArgs: string[];
      if (Array.isArray(rawFiles) && rawFiles.length > 0) {
        const files = rawFiles.map(String);
        const pathErr = validatePaths(files, workspace);
        if (pathErr) return error(pathErr);
        addArgs = ["add", "--", ...files];
      } else if (addUntracked) {
        addArgs = ["add", "."];
      } else {
        addArgs = ["add", "-u"];
      }

      try {
        await runGit(addArgs, workspace, { signal, timeout: 15_000 });
      } catch (e) {
        return error(
          `git add failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }

      // Show what's now staged
      const statusResult = await execSafe(
        "git",
        ["diff", "--name-only", "--cached"],
        { cwd: workspace, signal },
      );
      const staged = statusResult.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      return successStructured({ staged, count: staged.length });
    },
  };
}

export interface GitCommitCallbackResult {
  hash: string;
  branch: string;
  message: string;
  files: string[];
  count: number;
}

export function createGitCommitTool(
  workspace: string,
  onGitCommit?: (result: GitCommitCallbackResult) => void,
) {
  return {
    schema: {
      name: "gitCommit",
      description:
        "Create a git commit from staged changes. Use gitAdd first, or pass files to stage-and-commit in one step. " +
        "Returns the new commit hash, branch, and list of committed files.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "Commit message",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Files to stage before committing. If omitted, commits whatever is already staged.",
          },
          addAll: {
            type: "boolean",
            description:
              "Stage all tracked changes before committing (git add -u). Default: false.",
          },
        },
        required: ["message"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          hash: { type: "string" },
          branch: { type: "string" },
          message: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
        },
        required: ["hash", "branch", "message", "files", "count"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const message = requireString(args, "message", 4096);
      if (message.trim().length === 0) {
        return error("Commit message must not be empty");
      }

      const rawFiles = args.files;
      const addAll = optionalBool(args, "addAll") ?? false;

      // Stage files if requested
      if (Array.isArray(rawFiles) && rawFiles.length > 0) {
        const files = rawFiles.map(String);
        const pathErr = validatePaths(files, workspace);
        if (pathErr) return error(pathErr);
        try {
          await runGit(["add", "--", ...files], workspace, {
            signal,
            timeout: 15_000,
          });
        } catch (e) {
          return error(
            `git add failed: ${e instanceof Error ? e.message : "unknown error"}`,
          );
        }
      } else if (addAll) {
        try {
          await runGit(["add", "-u"], workspace, { signal, timeout: 15_000 });
        } catch (e) {
          return error(
            `git add -u failed: ${e instanceof Error ? e.message : "unknown error"}`,
          );
        }
      }

      // Check there is something staged
      const diffCheck = await execSafe("git", ["diff", "--cached", "--quiet"], {
        cwd: workspace,
        signal,
      });
      if (diffCheck.exitCode === 0) {
        // exit 0 = nothing staged (exit 1 = something staged; exit 128 = no HEAD
        // yet on initial repo — fall through and let `git commit` surface the error)
        const status = await execSafe("git", ["status", "--short"], {
          cwd: workspace,
          signal,
        });
        return error(
          `Nothing staged to commit. ${
            status.stdout.trim()
              ? `Unstaged changes exist:\n${status.stdout.trim()}\nUse gitAdd or pass files to this tool.`
              : "Working tree is clean."
          }`,
        );
      }

      // Commit
      try {
        await runGit(["commit", "-m", message], workspace, {
          signal,
          timeout: 30_000,
        });
      } catch (e) {
        return error(
          `git commit failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }

      // Get commit hash
      const hashResult = await execSafe("git", ["rev-parse", "HEAD"], {
        cwd: workspace,
        signal,
      });
      const hash = hashResult.stdout.trim().slice(0, 12);
      const branch = await currentBranch(workspace, signal);

      // List files that actually landed in the commit (post-commit, so pre-commit
      // hooks that stage additional files are included in the reported list).
      const diffTreeResult = await execSafe(
        "git",
        ["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"],
        { cwd: workspace, signal },
      );
      const committedFiles = diffTreeResult.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      const commitResult = {
        hash,
        branch,
        message,
        files: committedFiles,
        count: committedFiles.length,
      };
      onGitCommit?.(commitResult);
      return successStructured(commitResult);
    },
  };
}

export interface BranchCheckoutCallbackResult {
  branch: string;
  previousBranch: string | null;
  created: boolean;
}

export function createGitCheckoutTool(
  workspace: string,
  onBranchCheckout?: (result: BranchCheckoutCallbackResult) => void,
) {
  return {
    schema: {
      name: "gitCheckout",
      description:
        "Switch to a branch, or create and switch to a new branch. Use create: true to create from HEAD or a specified base.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          branch: {
            type: "string",
            description: "Branch name to switch to or create",
          },
          create: {
            type: "boolean",
            description:
              "Create the branch if it does not exist. Default: false.",
          },
          base: {
            type: "string",
            description:
              "Base branch or commit to create from (only used when create: true). Defaults to HEAD.",
          },
        },
        required: ["branch"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
          previousBranch: { type: ["string", "null"] },
          created: { type: "boolean" },
        },
        required: ["branch", "created"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const branch = requireString(args, "branch");
      const create = optionalBool(args, "create") ?? false;
      const base = optionalString(args, "base");

      // Validate ref names to prevent git flag injection (e.g. --orphan, -b)
      if (!isValidRef(branch)) {
        return error(`Invalid branch name: "${branch}"`);
      }
      if (base !== undefined && !isValidRef(base)) {
        return error(`Invalid base ref: "${base}"`);
      }

      const prevBranch = await currentBranch(workspace, signal);

      let checkoutArgs: string[];
      if (create) {
        checkoutArgs = base
          ? ["checkout", "-b", branch, base]
          : ["checkout", "-b", branch];
      } else {
        checkoutArgs = ["checkout", branch];
      }

      try {
        await runGit(checkoutArgs, workspace, { signal, timeout: 15_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        // Surface helpful hints for common errors
        if (msg.includes("already exists")) {
          return error(
            `Branch '${branch}' already exists. Use create: false to switch to it, or choose a different name.`,
          );
        }
        if (msg.includes("did not match") || msg.includes("pathspec")) {
          return error(
            `Branch '${branch}' not found locally. If it exists on remote, run gitFetch first to update remote-tracking branches, then retry.`,
          );
        }
        if (msg.includes("local changes")) {
          return error(
            `Cannot switch branch: you have uncommitted changes. Use gitStash to save them, then switch branches and use gitStashPop to restore.\n${msg}`,
          );
        }
        return error(`git checkout failed: ${msg}`);
      }

      const newBranch = await currentBranch(workspace, signal);
      const checkoutResult = {
        branch: newBranch,
        // If HEAD was detached, prevBranch is the literal string "HEAD" which
        // cannot be passed back to gitCheckout to restore position. Annotate it
        // so callers know to use the commit hash instead.
        previousBranch: prevBranch === "HEAD" ? null : prevBranch,
        previousCommit:
          prevBranch === "HEAD"
            ? (
                await execSafe("git", ["rev-parse", "HEAD"], {
                  cwd: workspace,
                  signal,
                })
              ).stdout
                .trim()
                .slice(0, 12)
            : undefined,
        wasDetached: prevBranch === "HEAD" || undefined,
        created: create,
      };
      onBranchCheckout?.({
        branch: checkoutResult.branch,
        previousBranch: checkoutResult.previousBranch,
        created: checkoutResult.created,
      });
      return successStructured(checkoutResult);
    },
  };
}

export function createGitBlameTool(workspace: string) {
  return {
    schema: {
      name: "gitBlame",
      description:
        "Show who last modified each line of a file and in which commit. " +
        "Use to trace why code was written a certain way or find the commit that introduced a bug.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
          startLine: {
            type: "number",
            description:
              "First line number to blame (1-based, inclusive). Omit for start of file.",
          },
          endLine: {
            type: "number",
            description:
              "Last line number to blame (1-based, inclusive). Omit for end of file.",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          lines: { type: "array" },
          count: { type: "integer" },
        },
        required: ["lines", "count"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);
      const startLine =
        typeof args.startLine === "number"
          ? Math.max(1, Math.floor(args.startLine))
          : undefined;
      const endLine =
        typeof args.endLine === "number"
          ? Math.max(1, Math.floor(args.endLine))
          : undefined;

      const blameArgs = ["blame", "--porcelain"];
      if (startLine !== undefined && endLine !== undefined) {
        blameArgs.push(`-L${startLine},${endLine}`);
      } else if (startLine !== undefined) {
        blameArgs.push(`-L${startLine},+50`); // default 50 lines if only start given
      }
      blameArgs.push("--", filePath);

      let blameOutput: string;
      try {
        ({ stdout: blameOutput } = await runGit(blameArgs, workspace, {
          signal,
          timeout: 15_000,
          maxBuffer: 512 * 1024,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        if (msg.includes("no such path")) {
          return error(`File not tracked by git: ${filePath}`);
        }
        return error(`git blame failed: ${msg}`);
      }

      // Parse porcelain format
      const lines = blameOutput.split("\n");
      const commits = new Map<
        string,
        {
          author: string;
          authorEmail: string;
          summary: string;
          timestamp: number;
        }
      >();
      const blameLines: Array<{
        line: number;
        hash: string;
        author: string;
        summary: string;
        code: string;
      }> = [];

      let currentHash = "";
      let lineNum = 0;

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i] ?? "";
        if (!l) continue;

        const headerMatch = l.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
        if (headerMatch) {
          currentHash = headerMatch[1] ?? "";
          lineNum = Number.parseInt(headerMatch[2] ?? "0", 10);
          continue;
        }

        if (!currentHash) continue;

        if (l.startsWith("author ") && !l.startsWith("author-")) {
          const existing = commits.get(currentHash);
          if (!existing) {
            commits.set(currentHash, {
              author: l.slice(7),
              authorEmail: "",
              summary: "",
              timestamp: 0,
            });
          } else {
            existing.author = l.slice(7);
          }
        } else if (l.startsWith("author-mail ")) {
          const entry = commits.get(currentHash);
          if (entry) entry.authorEmail = l.slice(12).replace(/[<>]/g, "");
        } else if (l.startsWith("author-time ")) {
          const entry = commits.get(currentHash);
          if (entry) entry.timestamp = Number.parseInt(l.slice(12), 10);
        } else if (l.startsWith("summary ")) {
          const entry = commits.get(currentHash);
          if (entry) entry.summary = l.slice(8);
        } else if (l.startsWith("\t")) {
          const info = commits.get(currentHash);
          if (info && lineNum > 0) {
            blameLines.push({
              line: lineNum,
              hash: currentHash.slice(0, 12),
              author: info.author,
              summary: info.summary,
              code: l.slice(1),
            });
            lineNum = 0;
          }
        }
      }

      return successStructured({ lines: blameLines, count: blameLines.length });
    },
  };
}

export function createGitFetchTool(workspace: string) {
  return {
    schema: {
      name: "gitFetch",
      description:
        "Fetch updates from a remote without merging. Updates remote-tracking branches so gitListBranches " +
        "and gitCheckout see the latest state. Use gitPull to fetch and merge in one step.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          remote: {
            type: "string",
            description: "Remote to fetch from (default: origin)",
          },
          all: {
            type: "boolean",
            description: "Fetch from all configured remotes. Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          fetched: { type: "boolean" },
          nothingNew: { type: "boolean" },
          output: { type: "string" },
        },
        required: ["fetched"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const all = optionalBool(args, "all") ?? false;
      const remote = optionalString(args, "remote", 256) ?? "origin";

      if (!all && !isValidRef(remote)) {
        return error(`Invalid remote name: "${remote}"`);
      }

      const fetchArgs = all ? ["fetch", "--all"] : ["fetch", remote];

      let fetchStdout: string;
      let fetchStderr: string;
      try {
        ({ stdout: fetchStdout, stderr: fetchStderr } = await runGit(
          fetchArgs,
          workspace,
          { signal, timeout: 60_000 },
        ));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        if (
          msg.includes("Authentication") ||
          msg.includes("credential") ||
          msg.includes("Permission denied") ||
          msg.includes("could not read Username")
        ) {
          return error(
            `Authentication failed. Check your git credentials.\n${msg}`,
          );
        }
        if (msg.includes("does not appear") || msg.includes("not found")) {
          return error(
            `Remote '${remote}' not found. Check configured remotes.`,
          );
        }
        return error(`git fetch failed: ${msg}`);
      }

      // git fetch writes to stderr even on success; empty = nothing new
      const output = fetchStderr.trim() || fetchStdout.trim();
      return successStructured({ fetched: true, nothingNew: !output, output });
    },
  };
}

export function createGitListBranchesTool(workspace: string) {
  return {
    schema: {
      name: "gitListBranches",
      description:
        "List git branches. Returns local branches with the current branch marked. Pass includeRemote: true for remote-tracking branches.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          includeRemote: {
            type: "boolean",
            description:
              "Include remote-tracking branches (e.g. origin/main). Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          local: { type: "array" },
          current: { type: "string" },
          remote: { type: "array", items: { type: "string" } },
        },
        required: ["local", "current"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const includeRemote = optionalBool(args, "includeRemote") ?? false;

      let branchOutput: string;
      try {
        ({ stdout: branchOutput } = await runGit(["branch"], workspace, {
          signal,
        }));
      } catch (e) {
        return error(
          `git branch failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }

      const local = branchOutput
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .map((l) => ({
          name: l.startsWith("* ") ? l.slice(2) : l.trimStart(),
          current: l.startsWith("* "),
        }));

      const current = local.find((b) => b.current)?.name ?? "";
      const result: {
        local: typeof local;
        current: string;
        remote?: string[];
      } = { local, current };

      if (includeRemote) {
        const remoteResult = await execSafe("git", ["branch", "-r"], {
          cwd: workspace,
          signal,
        });
        if (remoteResult.exitCode === 0) {
          result.remote = remoteResult.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .filter((b) => !b.includes("HEAD ->"));
        }
      }

      return successStructured(result);
    },
  };
}

export function createGitPullTool(
  workspace: string,
  onGitPull?: (result: GitPullCallbackResult) => void,
) {
  return {
    schema: {
      name: "gitPull",
      description:
        "Pull changes from a remote into the current branch. Defaults to origin with merge. Use rebase: true for linear history.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: {
            type: "string",
            description:
              "Remote branch to pull from (default: tracking branch for current branch)",
          },
          rebase: {
            type: "boolean",
            description:
              "Rebase local commits on top of remote changes instead of merging. Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          alreadyUpToDate: { type: "boolean" },
          output: { type: "string" },
        },
        required: ["alreadyUpToDate"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const remote = optionalString(args, "remote", 256) ?? "origin";
      const branch = optionalString(args, "branch", 256);
      const rebase = optionalBool(args, "rebase") ?? false;

      if (!isValidRef(remote)) {
        return error(`Invalid remote name: "${remote}"`);
      }
      if (branch !== undefined && !isValidRef(branch)) {
        return error(`Invalid branch name: "${branch}"`);
      }

      const pullArgs = ["pull"];
      if (rebase) pullArgs.push("--rebase");
      pullArgs.push(remote);
      if (branch) pullArgs.push(branch);

      let pullOutput: string;
      try {
        ({ stdout: pullOutput } = await runGit(pullArgs, workspace, {
          signal,
          timeout: 60_000,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        if (msg.includes("CONFLICT")) {
          return error(
            `Merge conflict during pull. Resolve conflicts manually, then use gitAdd + gitCommit.\n${msg}`,
          );
        }
        if (
          msg.includes("no tracking information") ||
          msg.includes("has no upstream") ||
          msg.includes("no upstream")
        ) {
          return error(
            "No upstream branch configured for the current branch. Specify remote and branch explicitly.",
          );
        }
        if (
          msg.includes("Authentication") ||
          msg.includes("credential") ||
          msg.includes("Permission denied") ||
          msg.includes("could not read Username")
        ) {
          return error(
            `Authentication failed. Check your git credentials.\n${msg}`,
          );
        }
        return error(`git pull failed: ${msg}`);
      }

      const alreadyUpToDate =
        pullOutput.includes("Already up to date") ||
        pullOutput.includes("Already up-to-date");

      const branchResult = await execSafe(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: workspace, signal },
      );
      const currentBranch = branchResult.stdout.trim() || branch || remote;
      onGitPull?.({ remote, branch: currentBranch, alreadyUpToDate });

      return successStructured({ alreadyUpToDate, output: pullOutput });
    },
  };
}

export interface GitPullCallbackResult {
  remote: string;
  branch: string;
  alreadyUpToDate: boolean;
}

export interface GitPushCallbackResult {
  remote: string;
  branch: string;
  hash: string;
}

export function createGitPushTool(
  workspace: string,
  onGitPush?: (result: GitPushCallbackResult) => void,
) {
  return {
    // Override the global 60s MCP tool timeout — SSH pushes on high-latency
    // VPS connections can take longer than 60s end-to-end.
    timeoutMs: 180_000,
    schema: {
      name: "gitPush",
      description:
        "Push the current branch to a remote. Use setUpstream: true on the first push. Force push uses --force-with-lease. Blocked on main/master.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: {
            type: "string",
            description: "Branch to push (default: current branch)",
          },
          setUpstream: {
            type: "boolean",
            description:
              "Set the upstream tracking branch (-u). Use on first push of a new branch. Default: false.",
          },
          force: {
            type: "boolean",
            description:
              "Force push with --force-with-lease. Blocked on main/master. Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          remote: { type: "string" },
          branch: { type: "string" },
          hash: { type: "string" },
          setUpstream: { type: "boolean" },
          output: { type: "string" },
        },
        required: ["remote", "branch", "hash"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const remote = optionalString(args, "remote", 256) ?? "origin";
      const branchArg = optionalString(args, "branch", 256);
      const setUpstream = optionalBool(args, "setUpstream") ?? false;
      const force = optionalBool(args, "force") ?? false;

      if (!isValidRef(remote)) {
        return error(`Invalid remote name: "${remote}"`);
      }
      if (branchArg !== undefined && !isValidRef(branchArg)) {
        return error(`Invalid branch name: "${branchArg}"`);
      }

      const branch = branchArg ?? (await currentBranch(workspace, signal));

      // Check force-push protection before anything else — this is a local safety
      // guard that must fire regardless of whether the remote exists.
      if (force && (branch === "main" || branch === "master")) {
        return error(
          `Force push to '${branch}' is blocked. This would rewrite shared history on the main branch.`,
        );
      }

      // Pre-flight: verify the remote exists before attempting the push so we
      // surface a clear message instead of a raw git error.
      const remoteCheck = await execSafe("git", ["remote", "get-url", remote], {
        cwd: workspace,
        signal,
      });
      if (remoteCheck.exitCode !== 0) {
        const knownRemotes = (
          await execSafe("git", ["remote"], { cwd: workspace, signal })
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean);
        const hint =
          knownRemotes.length > 0
            ? ` Known remotes: ${knownRemotes.join(", ")}.`
            : " No remotes are configured.";
        return error(
          `Remote "${remote}" does not exist in this repository.${hint}`,
        );
      }

      const pushArgs = ["push"];
      if (force) pushArgs.push("--force-with-lease");
      if (setUpstream) pushArgs.push("-u");
      pushArgs.push(remote, branch);

      let pushStdout: string;
      let pushStderr: string;
      try {
        ({ stdout: pushStdout, stderr: pushStderr } = await runGit(
          pushArgs,
          workspace,
          {
            signal,
            // SSH pushes on high-latency VPS connections can exceed 60s;
            // raise to 120s to avoid false-timeout failures.
            timeout: 120_000,
            // Inject SSH options: fast connect-timeout surfaces auth errors
            // immediately instead of hanging; keepalive prevents silent TCP drops.
            env: {
              ...process.env,
              GIT_SSH_COMMAND:
                "ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6",
            },
          },
        ));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        if (msg.includes("rejected") && msg.includes("non-fast-forward")) {
          return error(
            "Push rejected: remote has commits not present locally. Run gitPull to sync, then push again.",
          );
        }
        if (
          msg.includes("rejected") &&
          (msg.includes("stale") || msg.includes("force-with-lease"))
        ) {
          return error(
            "Force push rejected: remote branch was updated since your last fetch. Run gitPull to sync first.",
          );
        }
        if (
          msg.includes("has no upstream") ||
          msg.includes("no upstream branch")
        ) {
          return error(
            `Branch '${branch}' has no upstream. Use setUpstream: true to set the tracking branch on first push.`,
          );
        }
        if (
          msg.includes("Authentication") ||
          msg.includes("credential") ||
          msg.includes("Permission denied") ||
          msg.includes("Repository not found") ||
          msg.includes("could not read Username")
        ) {
          return error(
            `Authentication failed. Check your git credentials.\n${msg}`,
          );
        }
        return error(`git push failed: ${msg}`);
      }

      const hashResult = await execSafe("git", ["rev-parse", "HEAD"], {
        cwd: workspace,
        signal,
      });
      const hash = hashResult.stdout.trim().slice(0, 12);

      const pushResult = {
        remote,
        branch,
        hash,
        setUpstream,
        output: pushStderr.trim() || pushStdout.trim(),
      };
      onGitPush?.({ remote, branch, hash });
      return successStructured(pushResult);
    },
  };
}

export function createGitStashTool(workspace: string) {
  return {
    schema: {
      name: "gitStash",
      description:
        "Stash current changes to get a clean working tree. Required before switching branches with uncommitted changes. " +
        "Use gitStashPop to restore. Pass includeUntracked: true to also stash new files.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "Optional description for the stash entry",
          },
          includeUntracked: {
            type: "boolean",
            description: "Also stash untracked (new) files. Default: false.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          stashed: { type: "boolean" },
          stashRef: { type: "string" },
          output: { type: "string" },
          reason: { type: "string" },
        },
        required: ["stashed"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const message = optionalString(args, "message", 256);
      const includeUntracked = optionalBool(args, "includeUntracked") ?? false;

      const stashArgs = ["stash", "push"];
      if (includeUntracked) stashArgs.push("-u");
      if (message) stashArgs.push("-m", message);

      let stashStdout: string;
      let stashStderr: string;
      try {
        ({ stdout: stashStdout, stderr: stashStderr } = await runGit(
          stashArgs,
          workspace,
          { signal, timeout: 15_000 },
        ));
      } catch (e) {
        return error(
          `git stash failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }

      const output = stashStdout.trim() || stashStderr.trim();
      if (output.includes("No local changes to save")) {
        return successStructured({
          stashed: false,
          reason: "No local changes to save",
        });
      }

      const listResult = await execSafe(
        "git",
        ["stash", "list", "--max-count=1"],
        { cwd: workspace, signal },
      );
      const stashRef = listResult.stdout.trim().split(":")[0] ?? "stash@{0}";

      return successStructured({ stashed: true, stashRef, output });
    },
  };
}

export function createGitStashPopTool(workspace: string) {
  return {
    schema: {
      name: "gitStashPop",
      description:
        "Restore stashed changes to the working tree. Pops the most recent stash by default, " +
        "or a specific entry by index (from gitStashList).",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          index: {
            type: "integer",
            description:
              "Stash entry index to pop (0 = most recent). Default: 0.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          restored: { type: "boolean" },
          stashRef: { type: "string" },
          output: { type: "string" },
        },
        required: ["restored"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      const index =
        typeof args.index === "number"
          ? Math.max(0, Math.floor(args.index))
          : 0;
      const stashRef = `stash@{${index}}`;

      let popOutput: string;
      try {
        ({ stdout: popOutput } = await runGit(
          ["stash", "pop", stashRef],
          workspace,
          { signal, timeout: 15_000 },
        ));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        if (msg.includes("CONFLICT")) {
          return error(
            `Merge conflict while applying stash. Resolve conflicts, then use gitAdd to mark them resolved.\n${msg}`,
          );
        }
        if (
          msg.includes("No stash entries") ||
          msg.includes("is not a valid reference")
        ) {
          return error(
            `No stash entry at index ${index}. Use gitStashList to see available entries.`,
          );
        }
        return error(`git stash pop failed: ${msg}`);
      }

      return successStructured({
        restored: true,
        stashRef,
        output: popOutput.trim(),
      });
    },
  };
}

export function createGitStashListTool(workspace: string) {
  return {
    schema: {
      name: "gitStashList",
      description:
        "List all stash entries in the repository. " +
        "Returns each entry's index, branch it was stashed from, message, and age. " +
        "Use before gitStashPop to identify the right entry to restore.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          entries: { type: "array" },
          count: { type: "integer" },
        },
        required: ["entries", "count"],
      },
    },
    handler: async (_args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository", "git_error");
      }

      let listOutput: string;
      try {
        ({ stdout: listOutput } = await runGit(
          ["stash", "list", "--format=%gd|%gs|%cr"],
          workspace,
          { signal },
        ));
      } catch (e) {
        return error(
          `git stash list failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }

      const entries = listOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [ref, subject, age] = l.split("|");
          const index = Number.parseInt(
            ref?.match(/\{(\d+)\}/)?.[1] ?? "0",
            10,
          );
          return {
            index,
            ref: ref ?? "",
            subject: subject ?? "",
            age: age ?? "",
          };
        });

      return successStructured({ entries, count: entries.length });
    },
  };
}
