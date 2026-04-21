import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/github.js", () => ({
  fetchGitHubIssue: vi.fn(),
  fetchGitHubPR: vi.fn(),
}));

import { fetchGitHubIssue, fetchGitHubPR } from "../../connectors/github.js";
import { createFetchGithubIssueTool } from "../fetchGithubIssue.js";
import { createFetchGithubPRTool } from "../fetchGithubPR.js";

const mockFetchIssue = vi.mocked(fetchGitHubIssue);
const mockFetchPR = vi.mocked(fetchGitHubPR);

function structured(r: {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
}) {
  return (r.structuredContent ??
    JSON.parse(r.content[0]?.text ?? "{}")) as Record<string, unknown>;
}

const ISSUE_DETAIL = {
  number: 42,
  title: "Bug: something broke",
  body: "Steps to reproduce...",
  state: "open",
  url: "https://github.com/org/repo/issues/42",
  repo: "org/repo",
  author: "alice",
  labels: ["bug"],
  assignees: ["bob"],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  comments: 3,
};

const PR_DETAIL = {
  number: 7,
  title: "Fix: resolve the bug",
  body: "This PR fixes #42",
  state: "open",
  url: "https://github.com/org/repo/pull/7",
  repo: "org/repo",
  author: "alice",
  isDraft: false,
  reviewDecision: "APPROVED",
  labels: ["fix"],
  headBranch: "fix/bug",
  baseBranch: "main",
  createdAt: "2024-01-03T00:00:00Z",
  updatedAt: "2024-01-04T00:00:00Z",
  additions: 10,
  deletions: 5,
};

beforeEach(() => vi.clearAllMocks());

// ── fetchGithubIssue ──────────────────────────────────────────────────────────

describe("createFetchGithubIssueTool", () => {
  it("returns issue detail on success with URL ref", async () => {
    mockFetchIssue.mockResolvedValue(ISSUE_DETAIL);
    const tool = createFetchGithubIssueTool();
    const result = structured(
      await tool.handler({ issueRef: "https://github.com/org/repo/issues/42" }),
    );
    expect(result.number).toBe(42);
    expect(result.title).toBe("Bug: something broke");
    expect(result.author).toBe("alice");
    expect(result.labels).toEqual(["bug"]);
    expect(result.githubConnected).toBe(true);
    expect(mockFetchIssue).toHaveBeenCalledWith(
      "https://github.com/org/repo/issues/42",
      undefined,
    );
  });

  it("returns issue detail on success with short ref", async () => {
    mockFetchIssue.mockResolvedValue(ISSUE_DETAIL);
    const tool = createFetchGithubIssueTool();
    const result = structured(await tool.handler({ issueRef: "org/repo#42" }));
    expect(result.number).toBe(42);
    expect(result.githubConnected).toBe(true);
  });

  it("returns githubConnected: false when not connected", async () => {
    mockFetchIssue.mockRejectedValue(
      new Error("GitHub not connected. GET /connections/github/auth first."),
    );
    const tool = createFetchGithubIssueTool();
    const result = structured(await tool.handler({ issueRef: "org/repo#42" }));
    expect(result.githubConnected).toBe(false);
    expect(result.number).toBe(0);
    expect(result.error).toMatch(/not connected/i);
  });

  it("returns githubConnected: true with error on other failures", async () => {
    mockFetchIssue.mockRejectedValue(new Error("Issue not found"));
    const tool = createFetchGithubIssueTool();
    const result = structured(await tool.handler({ issueRef: "org/repo#999" }));
    expect(result.githubConnected).toBe(true);
    expect(result.error).toBe("Issue not found");
  });

  it("throws when issueRef missing", async () => {
    const tool = createFetchGithubIssueTool();
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("passes signal to fetchGitHubIssue", async () => {
    mockFetchIssue.mockResolvedValue(ISSUE_DETAIL);
    const tool = createFetchGithubIssueTool();
    const signal = new AbortController().signal;
    await tool.handler({ issueRef: "org/repo#42" }, signal);
    expect(mockFetchIssue).toHaveBeenCalledWith("org/repo#42", signal);
  });

  it("has correct schema name and required fields", () => {
    const tool = createFetchGithubIssueTool();
    expect(tool.schema.name).toBe("fetchGithubIssue");
    expect(tool.schema.inputSchema.required).toContain("issueRef");
    expect(tool.schema.outputSchema.required).toContain("githubConnected");
  });
});

// ── fetchGithubPR ─────────────────────────────────────────────────────────────

describe("createFetchGithubPRTool", () => {
  it("returns PR detail on success with URL ref", async () => {
    mockFetchPR.mockResolvedValue(PR_DETAIL);
    const tool = createFetchGithubPRTool();
    const result = structured(
      await tool.handler({ prRef: "https://github.com/org/repo/pull/7" }),
    );
    expect(result.number).toBe(7);
    expect(result.title).toBe("Fix: resolve the bug");
    expect(result.isDraft).toBe(false);
    expect(result.reviewDecision).toBe("APPROVED");
    expect(result.headBranch).toBe("fix/bug");
    expect(result.additions).toBe(10);
    expect(result.deletions).toBe(5);
    expect(result.githubConnected).toBe(true);
  });

  it("returns PR detail on success with short ref", async () => {
    mockFetchPR.mockResolvedValue(PR_DETAIL);
    const tool = createFetchGithubPRTool();
    const result = structured(await tool.handler({ prRef: "org/repo#7" }));
    expect(result.number).toBe(7);
    expect(result.githubConnected).toBe(true);
  });

  it("returns githubConnected: false when not connected", async () => {
    mockFetchPR.mockRejectedValue(
      new Error("GitHub not connected. GET /connections/github/auth first."),
    );
    const tool = createFetchGithubPRTool();
    const result = structured(await tool.handler({ prRef: "org/repo#7" }));
    expect(result.githubConnected).toBe(false);
    expect(result.number).toBe(0);
    expect(result.error).toMatch(/not connected/i);
  });

  it("returns githubConnected: true with error on other failures", async () => {
    mockFetchPR.mockRejectedValue(new Error("PR not found"));
    const tool = createFetchGithubPRTool();
    const result = structured(await tool.handler({ prRef: "org/repo#999" }));
    expect(result.githubConnected).toBe(true);
    expect(result.error).toBe("PR not found");
  });

  it("throws when prRef missing", async () => {
    const tool = createFetchGithubPRTool();
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("passes signal to fetchGitHubPR", async () => {
    mockFetchPR.mockResolvedValue(PR_DETAIL);
    const tool = createFetchGithubPRTool();
    const signal = new AbortController().signal;
    await tool.handler({ prRef: "org/repo#7" }, signal);
    expect(mockFetchPR).toHaveBeenCalledWith("org/repo#7", signal);
  });

  it("has correct schema name and required fields", () => {
    const tool = createFetchGithubPRTool();
    expect(tool.schema.name).toBe("fetchGithubPR");
    expect(tool.schema.inputSchema.required).toContain("prRef");
    expect(tool.schema.outputSchema.required).toContain("githubConnected");
  });

  it("returns zero-value numerics on error path", async () => {
    mockFetchPR.mockRejectedValue(new Error("network error"));
    const tool = createFetchGithubPRTool();
    const result = structured(await tool.handler({ prRef: "org/repo#1" }));
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.labels).toEqual([]);
  });
});
