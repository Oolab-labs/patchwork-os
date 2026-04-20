/**
 * GitHub connector — uses the `gh` CLI for all operations.
 * No OAuth app required; piggybacks on `gh auth login`.
 *
 * Exported step helpers used by yamlRunner:
 *   listIssues(opts)  — open issues assigned to / mentioning viewer
 *   listPRs(opts)     — open PRs authored by / requested for review by viewer
 *   getStatus()       — { connected: boolean, user?: string }
 */

import { spawnSync } from "node:child_process";

export interface GitHubIssue {
  number: number;
  title: string;
  repo: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  repo: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  updatedAt: string;
}

export interface ListIssuesOpts {
  assignee?: string;
  mention?: string;
  limit?: number;
  repo?: string;
}

export interface ListPRsOpts {
  author?: string;
  reviewRequested?: string;
  limit?: number;
  repo?: string;
}

function gh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, GITHUB_TOKEN: undefined },
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function getStatus(): { connected: boolean; user?: string } {
  // Try --json hosts (gh ≥ 2.40); fall back to --json loggedInAccounts (older)
  // then to plain text parsing for very old versions.
  const r = gh(["auth", "status", "--json", "hosts"]);
  if (r.ok) {
    try {
      const data = JSON.parse(r.stdout) as {
        hosts?: Record<string, Array<{ login?: string; active?: boolean }>>;
      };
      const accounts = Object.values(data.hosts ?? {}).flat();
      const active = accounts.find((a) => a.active) ?? accounts[0];
      return { connected: accounts.length > 0, user: active?.login };
    } catch {
      return { connected: true };
    }
  }
  // Older gh: loggedInAccounts field
  const r2 = gh(["auth", "status", "--json", "loggedInAccounts"]);
  if (r2.ok) {
    try {
      const data = JSON.parse(r2.stdout) as {
        loggedInAccounts?: Array<{ user: string }>;
      };
      const user = data.loggedInAccounts?.[0]?.user;
      return { connected: true, user };
    } catch {
      return { connected: true };
    }
  }
  // Plain text fallback
  const r3 = gh(["auth", "status"]);
  if (!r3.ok) return { connected: false };
  const match = /Logged in to .+ account (\S+)/.exec(r3.stdout + r3.stderr);
  return { connected: true, user: match?.[1] };
}

export function listIssues(opts: ListIssuesOpts = {}): GitHubIssue[] {
  const args = ["issue", "list", "--json", "number,title,url,labels,updatedAt"];
  if (opts.repo) {
    args.push("--repo", opts.repo);
  }
  if (opts.assignee) args.push("--assignee", opts.assignee);
  if (opts.mention) args.push("--mention", opts.mention);
  args.push("--limit", String(Math.min(opts.limit ?? 20, 50)));

  const r = gh(args);
  if (!r.ok) return [];
  try {
    const raw = JSON.parse(r.stdout) as Array<{
      number: number;
      title: string;
      url: string;
      labels: Array<{ name: string }>;
      updatedAt: string;
    }>;
    const repo = opts.repo ?? inferRepo();
    return raw.map((i) => ({
      number: i.number,
      title: i.title,
      repo,
      url: i.url,
      labels: i.labels.map((l) => l.name),
      updatedAt: i.updatedAt,
    }));
  } catch {
    return [];
  }
}

export function listPRs(opts: ListPRsOpts = {}): GitHubPR[] {
  const args = [
    "pr",
    "list",
    "--json",
    "number,title,url,isDraft,reviewDecision,updatedAt",
  ];
  if (opts.repo) {
    args.push("--repo", opts.repo);
  }
  if (opts.author) args.push("--author", opts.author);
  if (opts.reviewRequested)
    args.push("--review-requested", opts.reviewRequested);
  args.push("--limit", String(Math.min(opts.limit ?? 20, 50)));

  const r = gh(args);
  if (!r.ok) return [];
  try {
    const raw = JSON.parse(r.stdout) as Array<{
      number: number;
      title: string;
      url: string;
      isDraft: boolean;
      reviewDecision: string;
      updatedAt: string;
    }>;
    const repo = opts.repo ?? inferRepo();
    return raw.map((p) => ({
      number: p.number,
      title: p.title,
      repo,
      url: p.url,
      isDraft: p.isDraft,
      reviewDecision: p.reviewDecision ?? "",
      updatedAt: p.updatedAt,
    }));
  } catch {
    return [];
  }
}

function inferRepo(): string {
  const r = gh(["repo", "view", "--json", "nameWithOwner"]);
  if (!r.ok) return "";
  try {
    return (JSON.parse(r.stdout) as { nameWithOwner: string }).nameWithOwner;
  } catch {
    return "";
  }
}
