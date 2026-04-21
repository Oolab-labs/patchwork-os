import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGithubApprovePRTool,
  createGithubGetPRDiffTool,
  createGithubMergePRTool,
  createGithubPostPRReviewTool,
} from "../github/pr.js";

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

function parse(result: {
  content: Array<{ type: string; text: string }>;
  isError?: true;
}) {
  const raw = JSON.parse(result.content.at(0)?.text ?? "{}") as unknown;
  // New error format: { error: "...", code?: "..." } — unwrap to the error string for backward-compat
  if (
    result.isError &&
    typeof raw === "object" &&
    raw !== null &&
    "error" in (raw as object) &&
    typeof (raw as Record<string, unknown>).error === "string"
  ) {
    return (raw as Record<string, unknown>).error as string;
  }
  return raw;
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
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeMeta),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        stdout: "diff --git a/src/foo.ts b/src/foo.ts\n+added line",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 50,
      });

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
    const fakeMeta = {
      number: 1,
      title: "Big PR",
      state: "OPEN",
      changedFiles: 0,
      files: [],
    };
    const bigDiff = "x".repeat(300 * 1024);
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeMeta),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: bigDiff,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 50,
      });

    const result = await tool.handler({ prNumber: 1 });
    const data = parse(result);
    expect(data.truncated).toBe(true);
  });

  it("returns diff placeholder when diff fetch fails (non-fatal)", async () => {
    const fakeMeta = {
      number: 5,
      title: "Merged PR",
      state: "MERGED",
      changedFiles: 1,
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
    };
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeMeta),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "head ref does not exist",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 5 });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.diff).toContain("diff unavailable");
    expect(data.state).toBe("MERGED");
  });

  it("returns empty diff without error for zero-change PR", async () => {
    const fakeMeta = {
      number: 3,
      title: "Docs only",
      state: "OPEN",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
    };
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeMeta),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 3 });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.diff).toBe("");
    expect(data.additions).toBe(0);
  });

  it("sets filesIncomplete when files array is shorter than changedFiles", async () => {
    const fakeMeta = {
      number: 7,
      title: "Large PR",
      state: "OPEN",
      changedFiles: 500,
      files: Array.from({ length: 30 }, (_, i) => ({
        path: `f${i}.ts`,
        additions: 1,
        deletions: 0,
      })),
    };
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeMeta),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: "diff content",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 7 });
    const data = parse(result);
    expect(data.filesIncomplete).toBe(true);
    expect(data.filesNote).toContain("30");
    expect(data.filesNote).toContain("500");
  });

  it("requires prNumber", async () => {
    await expect(tool.handler({})).rejects.toThrow(/prNumber/);
  });
});

describe("githubPostPRReview", () => {
  const tool = createGithubPostPRReviewTool(workspace);

  it("returns isError for invalid event value", async () => {
    const result = await tool.handler({
      prNumber: 1,
      body: "review",
      event: "APPROVE",
    });
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
    mockExecSafe.mockResolvedValue({
      stdout: "",
      stderr: "not a git repo",
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
    });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/repository/i);
  });

  it("posts review with correct args and returns reviewId", async () => {
    const fakeReview = {
      id: 123456,
      html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-123456",
    };
    // First call: gh repo view (resolve repo), second call: gh api (post review)
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "owner/repo\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify(fakeReview),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 50,
      });

    const result = await tool.handler({
      prNumber: 1,
      body: "Looks good overall",
      event: "COMMENT",
      comments: [
        { path: "src/foo.ts", line: 10, body: "Potential null deref" },
      ],
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
      .mockResolvedValueOnce({
        stdout: "owner/repo\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 1, html_url: "" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      });

    await tool.handler({
      prNumber: 1,
      body: "review",
      comments: [
        {
          path: "src/foo.ts",
          line: 5,
          side: "LEFT",
          body: "This deleted line has a bug",
        },
      ],
    });

    const apiOpts = mockExecSafe.mock.calls[1]?.[2] as { stdin?: string };
    const payload = JSON.parse(apiOpts.stdin!);
    expect(payload.comments[0].side).toBe("LEFT");
  });

  it("returns isError on HTTP 401 from gh api", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "owner/repo\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          "gh: HTTP 401 (https://api.github.com/repos/owner/repo/pulls/1/reviews)",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/gh auth login/i);
  });

  it("rejects comment paths with path traversal", async () => {
    const result = await tool.handler({
      prNumber: 1,
      body: "review",
      comments: [{ path: "../../../etc/passwd", line: 1, body: "bad" }],
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/cannot contain/);
  });

  it("rejects comment paths starting with /", async () => {
    const result = await tool.handler({
      prNumber: 1,
      body: "review",
      comments: [{ path: "/etc/passwd", line: 1, body: "bad" }],
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/cannot .* start with/i);
  });

  it("returns clear error on HTTP 429 rate limit", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "owner/repo\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          "gh: HTTP 429 (https://api.github.com/repos/owner/repo/pulls/1/reviews)",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/rate limit/i);
  });

  it("returns clear error on HTTP 403", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "owner/repo\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          "gh: HTTP 403 (https://api.github.com/repos/owner/repo/pulls/1/reviews)",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 1, body: "review" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/forbidden/i);
  });

  it("requires prNumber and body", async () => {
    await expect(tool.handler({ body: "review" })).rejects.toThrow(/prNumber/);
    await expect(tool.handler({ prNumber: 1 })).rejects.toThrow(/body/);
  });
});

// ── githubApprovePR ───────────────────────────────────────────────────────────

describe("githubApprovePR", () => {
  const tool = createGithubApprovePRTool(workspace);

  it("approves PR and returns reviewId and url", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 99,
          html_url: "https://github.com/org/repo/pull/7#pullrequestreview-99",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 7 });
    expect(result.isError).toBeUndefined();
    const data = parse(result) as Record<string, unknown>;
    expect(data.reviewId).toBe(99);
    expect(data.url).toContain("github.com");
  });

  it("sends APPROVE event to GitHub API", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 1,
          html_url: "https://github.com/org/repo/pull/7",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
      });

    await tool.handler({ prNumber: 7, body: "LGTM" });
    const call = mockExecSafe.mock.calls[1];
    expect(call?.[2]?.stdin).toContain('"APPROVE"');
    expect(call?.[2]?.stdin).toContain("LGTM");
  });

  it("returns isError on API failure", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "HTTP 422: validation failed",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 7 });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/Failed to approve/);
  });

  it("returns isError when repo cannot be resolved", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "not a git repo",
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
    });

    const result = await tool.handler({ prNumber: 7 });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/repository/i);
  });

  it("requires prNumber", async () => {
    await expect(tool.handler({})).rejects.toThrow(/prNumber/);
  });

  it("has correct schema name and required fields", () => {
    expect(tool.schema.name).toBe("githubApprovePR");
    expect(tool.schema.inputSchema.required).toContain("prNumber");
    expect(tool.schema.outputSchema.required).toContain("reviewId");
    expect(tool.schema.outputSchema.required).toContain("url");
  });
});

// ── githubMergePR ─────────────────────────────────────────────────────────────

describe("githubMergePR", () => {
  const tool = createGithubMergePRTool(workspace);

  it("merges PR and returns merged/sha/message", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          merged: true,
          sha: "abc123",
          message: "Pull request successfully merged",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 15,
      });

    const result = await tool.handler({ prNumber: 7 });
    expect(result.isError).toBeUndefined();
    const data = parse(result) as Record<string, unknown>;
    expect(data.merged).toBe(true);
    expect(data.sha).toBe("abc123");
  });

  it("passes mergeMethod to API", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          merged: true,
          sha: "def456",
          message: "Squashed",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 15,
      });

    await tool.handler({ prNumber: 7, mergeMethod: "squash" });
    const call = mockExecSafe.mock.calls[1];
    expect(call?.[2]?.stdin).toContain('"squash"');
  });

  it("returns isError when PR is not mergeable", async () => {
    mockExecSafe
      .mockResolvedValueOnce({
        stdout: "org/repo",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "HTTP 405: not mergeable",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      });

    const result = await tool.handler({ prNumber: 7 });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/not mergeable/i);
  });

  it("rejects invalid mergeMethod", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: "org/repo",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
    });

    const result = await tool.handler({
      prNumber: 7,
      mergeMethod: "fast-forward",
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/invalid mergemethod/i);
  });

  it("requires prNumber", async () => {
    await expect(tool.handler({})).rejects.toThrow(/prNumber/);
  });

  it("has correct schema name and required fields", () => {
    expect(tool.schema.name).toBe("githubMergePR");
    expect(tool.schema.inputSchema.required).toContain("prNumber");
    expect(tool.schema.outputSchema.required).toContain("merged");
    expect(tool.schema.outputSchema.required).toContain("sha");
  });
});
