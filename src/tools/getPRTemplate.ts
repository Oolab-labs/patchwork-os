import { runGitStdout } from "./git-utils.js";
import { error, execSafe, optionalString, successStructured } from "./utils.js";

function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 10_000,
): Promise<string> {
  return runGitStdout(args, cwd, { signal, timeout });
}

async function detectBaseBranch(
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  // Try to find main or master
  const branches = await runGit(
    ["branch", "-r", "--format=%(refname:short)"],
    workspace,
    signal,
  );
  for (const line of branches.split("\n")) {
    const b = line.trim();
    if (b === "origin/main" || b === "origin/master") {
      return b.replace("origin/", "");
    }
  }
  // Fall back to checking local branches
  const local = await runGit(
    ["branch", "--format=%(refname:short)"],
    workspace,
    signal,
  );
  for (const line of local.split("\n")) {
    const b = line.trim();
    if (b === "main" || b === "master") return b;
  }
  return "main";
}

function extractIssueRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    refs.add(`#${match[1]}`);
  }
  return Array.from(refs);
}

function formatBullet(
  commits: string[],
  stats: string,
  issueRefs: string[],
): string {
  const lines: string[] = ["## Changes", ""];
  for (const line of commits) {
    if (line.trim()) lines.push(`- ${line.trim()}`);
  }
  lines.push("", "## Files changed", "", stats.trim());
  if (issueRefs.length > 0) {
    lines.push("", `Closes ${issueRefs.join(", ")}`);
  }
  return lines.join("\n");
}

function formatProse(
  commits: string[],
  stats: string,
  issueRefs: string[],
): string {
  const summary =
    commits.length === 1
      ? (commits[0]?.trim() ?? "")
      : `This PR includes ${commits.length} commits: ${commits.map((c) => c.trim()).join("; ")}.`;
  const lines = [summary, "", stats.trim()];
  if (issueRefs.length > 0) {
    lines.push("", `Closes ${issueRefs.join(", ")}`);
  }
  return lines.join("\n");
}

function formatConventional(
  commits: string[],
  stats: string,
  issueRefs: string[],
): string {
  const grouped: Record<string, string[]> = {};
  for (const commit of commits) {
    const match = commit.trim().match(/^(\w+)(?:\(.+?\))?!?:\s+(.+)/);
    if (match) {
      const type = match[1] ?? "other";
      const msg = match[2] ?? commit.trim();
      (grouped[type] ??= []).push(msg);
    } else {
      (grouped.other ??= []).push(commit.trim());
    }
  }

  const lines: string[] = [];
  for (const [type, msgs] of Object.entries(grouped)) {
    lines.push(`### ${type}`);
    for (const m of msgs) lines.push(`- ${m}`);
    lines.push("");
  }
  lines.push("## Files changed", "", stats.trim());
  if (issueRefs.length > 0) {
    lines.push("", `Closes ${issueRefs.join(", ")}`);
  }
  return lines.join("\n");
}

export function createGetPRTemplateTool(workspace: string) {
  return {
    schema: {
      name: "getPRTemplate",
      description:
        "PR description from commits and diff stats vs base branch. Returns markdown → pass to githubCreatePR.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          base: {
            type: "string",
            description:
              "Base branch to compare against (default: auto-detect main/master)",
          },
          style: {
            type: "string",
            enum: ["bullet", "prose", "conventional"],
            description:
              "Output style: bullet (default), prose (paragraph), or conventional (grouped by commit type)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          body: { type: "string" },
          commits: { type: "number" },
          issueRefs: { type: "array", items: { type: "string" } },
          filesChanged: { type: "number" },
          base: { type: "string" },
          style: { type: "string" },
          note: { type: "string" },
        },
        required: ["body", "commits", "issueRefs", "filesChanged", "base"],
      },
    },
    timeoutMs: 15_000,

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const styleRaw = optionalString(args, "style") ?? "bullet";
      const style = ["bullet", "prose", "conventional"].includes(styleRaw)
        ? styleRaw
        : "bullet";

      // Verify git repo
      const check = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
        timeout: 5_000,
      });
      if (check.exitCode !== 0) {
        return error("Not a git repository");
      }

      let base = optionalString(args, "base");
      if (!base) {
        try {
          base = await detectBaseBranch(workspace, signal);
        } catch {
          base = "main";
        }
      }

      let commits: string[];
      let stats: string;
      let filesChanged = 0;

      try {
        const logOut = await runGit(
          ["log", `${base}..HEAD`, "--oneline", "--no-merges"],
          workspace,
          signal,
        );
        commits = logOut
          .split("\n")
          .map((l) => l.replace(/^[a-f0-9]+ /, "").trim())
          .filter(Boolean);

        const statOut = await runGit(
          ["diff", `${base}..HEAD`, "--stat", "--no-color"],
          workspace,
          signal,
        );
        stats = statOut.trim();

        // Extract file count from last stats line: "N files changed, ..."
        const lastLine = stats.split("\n").pop() ?? "";
        const fileMatch = lastLine.match(/(\d+)\s+file/);
        if (fileMatch) filesChanged = Number.parseInt(fileMatch[1] ?? "0", 10);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(
          `Failed to get git history: ${msg}. Ensure branch '${base}' exists.`,
        );
      }

      if (commits.length === 0) {
        return successStructured({
          body: "",
          commits: 0,
          issueRefs: [],
          filesChanged: 0,
          base,
          note: `No commits found between ${base} and HEAD`,
        });
      }

      const allText = commits.join("\n");
      const issueRefs = extractIssueRefs(allText);

      let body: string;
      switch (style) {
        case "prose":
          body = formatProse(commits, stats, issueRefs);
          break;
        case "conventional":
          body = formatConventional(commits, stats, issueRefs);
          break;
        default:
          body = formatBullet(commits, stats, issueRefs);
      }

      return successStructured({
        body,
        commits: commits.length,
        issueRefs,
        filesChanged,
        base,
        style,
      });
    },
  };
}
