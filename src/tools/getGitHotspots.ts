import {
  error,
  execSafe,
  optionalInt,
  optionalString,
  successStructuredLarge,
} from "./utils.js";

interface Hotspot {
  file: string;
  commits: number;
  rank: number;
}

export function createGetGitHotspotsTool(workspace: string) {
  return {
    schema: {
      name: "getGitHotspots",
      description:
        "Most frequently changed files in git history. High frequency → active dev or instability.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "integer",
            minimum: 1,
            maximum: 365,
            description: "Lookback window in days (default: 90)",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max hotspot files to return (default: 20)",
          },
          path: {
            type: "string",
            description:
              "Subdirectory or glob to scope analysis (e.g. 'src/'). Default: entire repo",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description: "ISO date string — start of the lookback window",
          },
          days: { type: "integer", description: "Lookback window in days" },
          totalCommitsScanned: {
            type: "integer",
            description: "Total commits in the time window",
          },
          hotspots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                commits: {
                  type: "integer",
                  description: "Number of commits touching this file",
                },
                rank: {
                  type: "integer",
                  description: "1-based rank by commit count",
                },
              },
              required: ["file", "commits", "rank"],
            },
          },
          scopedTo: {
            type: "string",
            description: "Present when analysis was scoped to a subdirectory",
          },
        },
        required: ["since", "days", "totalCommitsScanned", "hotspots"],
      },
    },
    timeoutMs: 15_000,

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const days = optionalInt(args, "days", 1, 365) ?? 90;
      const limit = optionalInt(args, "limit", 1, 100) ?? 20;
      const path = optionalString(args, "path");

      // Verify git repo
      const check = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
        timeout: 5_000,
      });
      if (check.exitCode !== 0) {
        return error("Not a git repository");
      }

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const gitArgs = [
        "log",
        `--since=${since}`,
        "--name-only",
        "--pretty=format:",
        "--no-renames",
        "--",
      ];
      if (path) {
        gitArgs.push(path);
      } else {
        gitArgs.push(".");
      }

      const result = await execSafe("git", gitArgs, {
        cwd: workspace,
        signal,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      if (result.timedOut) {
        return error("git log timed out");
      }

      // Count file appearances
      const counts = new Map<string, number>();
      let totalCommits = 0;

      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          // blank lines separate commits (after --pretty=format: they count commit boundaries)
          continue;
        }
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }

      // Count total commits by looking at lines that are empty (commit separators) —
      // actually count via a separate git command for accuracy
      const commitCountResult = await execSafe(
        "git",
        ["rev-list", "--count", `--since=${since}`, "HEAD"],
        { cwd: workspace, signal, timeout: 5_000 },
      );
      if (!commitCountResult.timedOut && commitCountResult.exitCode === 0) {
        totalCommits =
          Number.parseInt(commitCountResult.stdout.trim(), 10) || 0;
      }

      // Sort by commit count descending
      const sorted = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      const hotspots: Hotspot[] = sorted.map(([file, commits], i) => ({
        file,
        commits,
        rank: i + 1,
      }));

      return successStructuredLarge({
        since,
        days,
        totalCommitsScanned: totalCommits,
        hotspots,
        ...(path ? { scopedTo: path } : {}),
      });
    },
  };
}
