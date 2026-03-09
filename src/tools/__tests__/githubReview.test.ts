import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGithubGetPRDiffTool, createGithubPostPRReviewTool } from "../github/review.js";

// Mock execSafe at the utils module level
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    execSafe: vi.fn(),
  };
});

import { execSafe } from "../utils.js";
const mockExecSafe = vi.mocked(execSafe);

function parse(result: { content: Array<{ type: string; text: string }>; isError?: true }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

const workspace = "/fake/workspace";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("githubGetPRDiff", () => {
  const tool = createGithubGetPRDiffTool(workspace);

  it("returns isError when gh is not found", async () => {
    mockExecSafe.mockResolvedValue({
      stdout: "",
      stderr: "executable file not found in $PATH",
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
    });

    const result = await tool.handler({ prNumber: 42 });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/GitHub CLI/);
  });

  it("returns isError when PR is not found", async () => {
    mockExecSafe.mockResolvedValue({
      stdout: "",
      stderr: "Could not resolve to a PullRequest with the number of 9999",
      exitCode: 1,
      timedOut: false,
      durationMs: 10,
    });

    const result = await tool.handler({ prNumber: 9999 });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/not found/i);
  });

  it("returns combined metadata and diff on success", async () => {
    const fakeMeta = {
      number: 42,
      title: "Add feature",
      body: "Does stuff",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/x",
      additions: 10,
      deletions: 2,
      changedFiles: 1, // integer count
      files: [{ path: "src/foo.ts", additions: 10, deletions: 2 }], // per-file array
      author: { login: "dev" },
      createdAt: "2025-01-01T00:00:00Z",
      isDraft: false,
      mergeable: "MERGEABLE",
    };
    // First call: gh pr view (metadata), second call: gh pr diff
    mockExecSafe
      .mockResolvedValueOnce({ stdout: JSON.stringify(fakeMeta), stderr: "", exitCode: 0, timedOut: false, durationMs: 100 })
      .mockResolvedValueOnce({ stdout: "diff --git a/src/foo.ts b/src/foo.ts\n+added line", stderr: "", exitCode: 0, timedOut: false, durationMs: 50 });

    const result = await tool.handler({ prNumber: 42 });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.title).toBe("Add feature");
    expect(data.diff).toContain("added line");
    expect(data.changedFiles).toBe(1); // integer, not array
    expect(Array.isArray(data.files)).toBe(true); // per-file list
    expect(data.truncated).toBeUndefined();
  });

  it("sets truncated:true when diff exceeds 256 KB", async () => {
    const fakeMeta = { number: 1, title: "Big PR", state: "OPEN", changedFiles: 0, files: [] };
    const bigDiff = "x".repeat(300 * 1024);
    mockExecSafe
      .mockResolvedValueOnce({ stdout: JSON.stringify(fakeMeta), stderr: "", exitCode: 0, timedOut: false, durationMs: 10 })
      .mockResolvedValueOnce({ stdout: bigDiff, stderr: "", exitCode: 0, timedOut: false, durationMs: 50 });

    const result = await tool.handler({ prNumber: 1 });
    const data = parse(result);
    expect(data.truncated).toBe(true);
  });

  it("requires prNumber", async () => {
    await expect(tool.handler({})).rejects.toThrow(/prNumber/);
  });
});

describe("githubPostPRReview", () => {
  const tool = createGithubPostPRReviewTool(workspace);

  it("returns isError for invalid event value", async () => {
    const result = await tool.handler({ prNumber: 1, body: "review", event: "APPROVE" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/APPROVE/);
  });

  it("returns isError when comments contain invalid shape", async () => {
    const result = await tool.handler({
      prNumber: 1,
      body: "review",
      comments: [{ path: "foo.ts" }], // missing line and body
    });
    expect(result.isError).toBe(true);
  });

  it("returns isError when repo cannot be resolved", async () => {
    mockExecSafe.mockResolvedValue({ stdout: "", stderr: "not a git repo", exitCode: 1, timedOut: false, durationMs: 5 });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/repository/i);
  });

  it("posts review with correct args and returns reviewId", async () => {
    const fakeReview = { id: 123456, html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-123456" };
    // First call: gh repo view (resolve repo), second call: gh api (post review)
    mockExecSafe
      .mockResolvedValueOnce({ stdout: "owner/repo\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 5 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(fakeReview), stderr: "", exitCode: 0, timedOut: false, durationMs: 50 });

    const result = await tool.handler({
      prNumber: 1,
      body: "Looks good overall",
      event: "COMMENT",
      comments: [{ path: "src/foo.ts", line: 10, body: "Potential null deref" }],
    });

    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.reviewId).toBe(123456);
    expect(data.commentsPosted).toBe(1);
    expect(data.event).toBe("COMMENT");

    // Verify the API endpoint
    const apiCall = mockExecSafe.mock.calls[1]!;
    expect(apiCall[1]).toContain("repos/owner/repo/pulls/1/reviews");

    // Verify the stdin JSON payload structure
    const apiOpts = apiCall[2] as { stdin?: string };
    const payload = JSON.parse(apiOpts.stdin!);
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toBe("Looks good overall");
    expect(payload.comments[0].path).toBe("src/foo.ts");
    expect(payload.comments[0].line).toBe(10);
    expect(payload.comments[0].side).toBe("RIGHT"); // default side
    expect(payload.comments[0].body).toBe("Potential null deref");
  });

  it("sends side:LEFT for deleted-line comments", async () => {
    mockExecSafe
      .mockResolvedValueOnce({ stdout: "owner/repo\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 5 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 1, html_url: "" }), stderr: "", exitCode: 0, timedOut: false, durationMs: 10 });

    await tool.handler({
      prNumber: 1,
      body: "review",
      comments: [{ path: "src/foo.ts", line: 5, side: "LEFT", body: "This deleted line has a bug" }],
    });

    const apiOpts = mockExecSafe.mock.calls[1]![2] as { stdin?: string };
    const payload = JSON.parse(apiOpts.stdin!);
    expect(payload.comments[0].side).toBe("LEFT");
  });

  it("returns isError on HTTP 401 from gh api", async () => {
    mockExecSafe
      .mockResolvedValueOnce({ stdout: "owner/repo\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 5 })
      .mockResolvedValueOnce({ stdout: "", stderr: "gh: HTTP 401 (https://api.github.com/repos/owner/repo/pulls/1/reviews)", exitCode: 1, timedOut: false, durationMs: 10 });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/gh auth login/i);
  });

  it("requires prNumber and body", async () => {
    await expect(tool.handler({ body: "review" })).rejects.toThrow(/prNumber/);
    await expect(tool.handler({ prNumber: 1 })).rejects.toThrow(/body/);
  });
});
