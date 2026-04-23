import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import {
  createGithubActionsTool,
  createGithubIssueTool,
  createGithubPRTool,
} from "../github/composite.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const ws = "/fake/workspace";

function parse(r: {
  content: Array<{ type: string; text: string }>;
  isError?: true;
}) {
  const raw = JSON.parse(r.content.at(0)?.text ?? "{}") as unknown;
  if (
    r.isError &&
    typeof raw === "object" &&
    raw !== null &&
    "error" in (raw as object) &&
    typeof (raw as Record<string, unknown>).error === "string"
  ) {
    return (raw as Record<string, unknown>).error as string;
  }
  return raw;
}

const ok = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  exitCode: 0,
  timedOut: false,
  durationMs: 20,
});

beforeEach(() => vi.resetAllMocks());

// ---------------------------------------------------------------------------
// githubPR composite
// ---------------------------------------------------------------------------
describe("githubPR", () => {
  it("create — dispatches to createPR handler", async () => {
    const tool = createGithubPRTool(ws);
    mockExecSafe
      .mockResolvedValueOnce(ok("https://github.com/owner/repo/pull/42"))
      .mockResolvedValueOnce(ok("feat/my-branch")); // git rev-parse for branch callback
    const result = await tool.handler({
      operation: "create",
      title: "My PR",
    });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.url).toBe("https://github.com/owner/repo/pull/42");
    expect(data.number).toBe(42);
    expect(data.title).toBe("My PR");
  });

  it("view — dispatches to viewPR handler", async () => {
    const tool = createGithubPRTool(ws);
    const prJson = JSON.stringify({
      number: 7,
      title: "Test PR",
      state: "OPEN",
      url: "https://github.com/owner/repo/pull/7",
    });
    mockExecSafe.mockResolvedValueOnce(ok(prJson));
    const result = await tool.handler({ operation: "view", number: 7 });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.number).toBe(7);
  });

  it("list — dispatches to listPRs handler", async () => {
    const tool = createGithubPRTool(ws);
    const prsJson = JSON.stringify([{ number: 1, title: "A" }]);
    mockExecSafe.mockResolvedValueOnce(ok(prsJson));
    const result = await tool.handler({ operation: "list" });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.count).toBe(1);
  });

  it("getDiff — dispatches to getPRDiff handler", async () => {
    const tool = createGithubPRTool(ws);
    const metaJson = JSON.stringify({
      number: 3,
      title: "Diff PR",
      body: null,
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feat",
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      files: [{ path: "src/foo.ts" }],
      author: {},
      createdAt: "2024-01-01",
      isDraft: false,
      mergeable: "MERGEABLE",
    });
    mockExecSafe
      .mockResolvedValueOnce(ok(metaJson))
      .mockResolvedValueOnce(ok("diff --git a/src/foo.ts b/src/foo.ts\n"));
    const result = await tool.handler({ operation: "getDiff", prNumber: 3 });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(typeof data.diff).toBe("string");
  });

  it("postReview — dispatches to postPRReview handler", async () => {
    const tool = createGithubPRTool(ws);
    // resolveRepo call
    mockExecSafe.mockResolvedValueOnce(ok("owner/repo"));
    // API call
    mockExecSafe.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          id: 99,
          html_url: "https://github.com/owner/repo/pull/5#pullrequestreview-99",
        }),
      ),
    );
    const result = await tool.handler({
      operation: "postReview",
      prNumber: 5,
      body: "LGTM",
      event: "COMMENT",
    });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.reviewId).toBe(99);
    expect(data.commentsPosted).toBe(0);
  });

  it("approve — dispatches to approvePR handler", async () => {
    const tool = createGithubPRTool(ws);
    mockExecSafe.mockResolvedValueOnce(ok("owner/repo"));
    mockExecSafe.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          id: 55,
          html_url: "https://github.com/owner/repo/pull/6#review-55",
        }),
      ),
    );
    const result = await tool.handler({ operation: "approve", prNumber: 6 });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.reviewId).toBe(55);
  });

  it("merge — dispatches to mergePR handler", async () => {
    const tool = createGithubPRTool(ws);
    mockExecSafe.mockResolvedValueOnce(ok("owner/repo"));
    mockExecSafe.mockResolvedValueOnce(
      ok(JSON.stringify({ merged: true, sha: "abc123", message: "Merged" })),
    );
    const result = await tool.handler({
      operation: "merge",
      prNumber: 8,
      mergeMethod: "squash",
    });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.merged).toBe(true);
  });

  it("unknown operation — returns error", async () => {
    const tool = createGithubPRTool(ws);
    const result = await tool.handler({ operation: "explode" });
    expect((result as { isError?: true }).isError).toBe(true);
    const msg = parse(result as Parameters<typeof parse>[0]);
    expect(typeof msg).toBe("string");
    expect(msg as string).toContain("Unknown operation");
  });
});

// ---------------------------------------------------------------------------
// githubIssue composite
// ---------------------------------------------------------------------------
describe("githubIssue", () => {
  it("list — dispatches to listIssues handler", async () => {
    const tool = createGithubIssueTool(ws);
    const issuesJson = JSON.stringify([{ number: 10, title: "Bug" }]);
    mockExecSafe.mockResolvedValueOnce(ok(issuesJson));
    const result = await tool.handler({ operation: "list" });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.count).toBe(1);
  });

  it("get — dispatches to getIssue handler", async () => {
    const tool = createGithubIssueTool(ws);
    const issueJson = JSON.stringify({
      number: 12,
      title: "Crash on startup",
      state: "OPEN",
      url: "https://github.com/owner/repo/issues/12",
    });
    mockExecSafe.mockResolvedValueOnce(ok(issueJson));
    const result = await tool.handler({ operation: "get", number: 12 });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.number).toBe(12);
  });

  it("create — dispatches to createIssue handler", async () => {
    const tool = createGithubIssueTool(ws);
    mockExecSafe.mockResolvedValueOnce(
      ok("https://github.com/owner/repo/issues/20"),
    );
    const result = await tool.handler({
      operation: "create",
      title: "New issue",
    });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.number).toBe(20);
  });

  it("comment — dispatches to commentIssue handler", async () => {
    const tool = createGithubIssueTool(ws);
    mockExecSafe.mockResolvedValueOnce(
      ok("https://github.com/owner/repo/issues/12#issuecomment-999"),
    );
    const result = await tool.handler({
      operation: "comment",
      number: 12,
      body: "Thanks for reporting!",
    });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.issueNumber).toBe(12);
  });

  it("unknown operation — returns error", async () => {
    const tool = createGithubIssueTool(ws);
    const result = await tool.handler({ operation: "delete" });
    expect((result as { isError?: true }).isError).toBe(true);
    const msg = parse(result as Parameters<typeof parse>[0]);
    expect(typeof msg).toBe("string");
    expect(msg as string).toContain("Unknown operation");
  });
});

// ---------------------------------------------------------------------------
// githubActions composite
// ---------------------------------------------------------------------------
describe("githubActions", () => {
  it("listRuns — dispatches to listRuns handler", async () => {
    const tool = createGithubActionsTool(ws);
    const runsJson = JSON.stringify([
      { databaseId: 111, name: "CI", status: "completed" },
    ]);
    mockExecSafe.mockResolvedValueOnce(ok(runsJson));
    const result = await tool.handler({ operation: "listRuns" });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(data.count).toBe(1);
  });

  it("getRunLogs — dispatches to getRunLogs handler", async () => {
    const tool = createGithubActionsTool(ws);
    mockExecSafe.mockResolvedValueOnce(
      ok("Step 1 failed\nError: out of memory"),
    );
    const result = await tool.handler({ operation: "getRunLogs", runId: 111 });
    const data = parse(result as Parameters<typeof parse>[0]) as Record<
      string,
      unknown
    >;
    expect(typeof data.logs).toBe("string");
  });

  it("unknown operation — returns error", async () => {
    const tool = createGithubActionsTool(ws);
    const result = await tool.handler({ operation: "restart" });
    expect((result as { isError?: true }).isError).toBe(true);
    const msg = parse(result as Parameters<typeof parse>[0]);
    expect(typeof msg).toBe("string");
    expect(msg as string).toContain("Unknown operation");
  });
});
