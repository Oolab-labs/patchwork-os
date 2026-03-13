import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import {
  createGithubGetRunLogsTool,
  createGithubListRunsTool,
} from "../github/actions.js";
import {
  createGithubCreateIssueTool,
  createGithubGetIssueTool,
  createGithubListIssuesTool,
} from "../github/issues.js";
import {
  createGithubCreatePRTool,
  createGithubListPRsTool,
  createGithubViewPRTool,
} from "../github/pr.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const ws = "/fake/workspace";

function parse(r: {
  content: Array<{ type: string; text: string }>;
  isError?: true;
}) {
  return JSON.parse(r.content.at(0)?.text ?? "{}");
}

const ok = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  exitCode: 0,
  timedOut: false,
  durationMs: 20,
});
const fail = (stderr: string, exitCode = 1) => ({
  stdout: "",
  stderr,
  exitCode,
  timedOut: false,
  durationMs: 20,
});

beforeEach(() => vi.clearAllMocks());

// ── githubListRuns ────────────────────────────────────────────────────────────

describe("createGithubListRunsTool", () => {
  it("returns run list on success", async () => {
    const runs = [
      { databaseId: 1, status: "completed", conclusion: "success", name: "CI" },
    ];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(runs)));
    const tool = createGithubListRunsTool(ws);
    const result = parse(await tool.handler({}));
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].databaseId).toBe(1);
  });

  it("passes branch/workflow/status/limit args", async () => {
    mockExecSafe.mockResolvedValue(ok("[]"));
    const tool = createGithubListRunsTool(ws);
    await tool.handler({
      branch: "main",
      workflow: "ci.yml",
      status: "failure",
      limit: 5,
    });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--branch");
    expect(args).toContain("main");
    expect(args).toContain("--workflow");
    expect(args).toContain("ci.yml");
    expect(args).toContain("--status");
    expect(args).toContain("failure");
    expect(args).toContain("5");
  });

  it("returns error on not-authed", async () => {
    mockExecSafe.mockResolvedValue(fail("HTTP 401"));
    const tool = createGithubListRunsTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("authenticated");
  });

  it("returns error on not-found", async () => {
    mockExecSafe.mockResolvedValue(fail("Could not resolve to a Repository"));
    const tool = createGithubListRunsTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it("returns error on JSON parse failure", async () => {
    mockExecSafe.mockResolvedValue(ok("not-json"));
    const tool = createGithubListRunsTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });
});

// ── githubGetRunLogs ──────────────────────────────────────────────────────────

describe("createGithubGetRunLogsTool", () => {
  it("returns log output on success", async () => {
    mockExecSafe.mockResolvedValue(ok("Build failed at step X"));
    const tool = createGithubGetRunLogsTool(ws);
    const result = parse(await tool.handler({ runId: 42 }));
    expect(result.logs).toContain("Build failed");
    expect(result.runId).toBe(42);
  });

  it("returns error when runId missing or invalid", async () => {
    const tool = createGithubGetRunLogsTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it("returns error on not-authed", async () => {
    mockExecSafe.mockResolvedValue(fail("HTTP 401"));
    const tool = createGithubGetRunLogsTool(ws);
    const result = await tool.handler({ runId: 1 });
    expect(result.isError).toBe(true);
  });
});

// ── githubListIssues ──────────────────────────────────────────────────────────

describe("createGithubListIssuesTool", () => {
  it("returns issues list on success", async () => {
    const issues = [{ number: 1, title: "Bug", state: "open", labels: [] }];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(issues)));
    const tool = createGithubListIssuesTool(ws);
    const result = parse(await tool.handler({}));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].number).toBe(1);
  });

  it("passes state/limit/assignee/label args", async () => {
    mockExecSafe.mockResolvedValue(ok("[]"));
    const tool = createGithubListIssuesTool(ws);
    await tool.handler({
      state: "closed",
      limit: 5,
      assignee: "@me",
      label: "bug",
    });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("closed");
    expect(args).toContain("@me");
    expect(args).toContain("bug");
    expect(args.some((a) => a.includes("5"))).toBe(true);
  });

  it("returns error on not-authed", async () => {
    mockExecSafe.mockResolvedValue(fail("HTTP 401"));
    const tool = createGithubListIssuesTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it("returns error on JSON parse failure", async () => {
    mockExecSafe.mockResolvedValue(ok("{bad}"));
    const tool = createGithubListIssuesTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });
});

// ── githubCreateIssue ─────────────────────────────────────────────────────────

describe("createGithubCreateIssueTool", () => {
  it("creates issue and returns url + number", async () => {
    const data = { url: "https://github.com/org/repo/issues/42", number: 42 };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(data)));
    const tool = createGithubCreateIssueTool(ws);
    const result = parse(await tool.handler({ title: "New issue" }));
    expect(result.url).toContain("issues/42");
    expect(result.number).toBe(42);
  });

  it("returns error when title missing", async () => {
    // requireString throws when field is missing
    const tool = createGithubCreateIssueTool(ws);
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("passes body/label/assignee args", async () => {
    mockExecSafe.mockResolvedValue(ok(JSON.stringify({ url: "u", number: 1 })));
    const tool = createGithubCreateIssueTool(ws);
    await tool.handler({
      title: "T",
      body: "B",
      label: "bug",
      assignee: "user",
    });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args.some((a) => a.includes("bug"))).toBe(true);
    expect(args.some((a) => a.includes("user"))).toBe(true);
  });

  it("returns error on gh failure", async () => {
    mockExecSafe.mockResolvedValue(fail("gh: error"));
    const tool = createGithubCreateIssueTool(ws);
    const result = await tool.handler({ title: "T" });
    expect(result.isError).toBe(true);
  });
});

// ── githubGetIssue ────────────────────────────────────────────────────────────

describe("createGithubGetIssueTool", () => {
  it("returns issue detail on success", async () => {
    const issue = {
      number: 5,
      title: "Issue",
      state: "open",
      body: "desc",
      labels: [],
      assignees: [],
      comments: [],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(issue)));
    const tool = createGithubGetIssueTool(ws);
    const result = parse(await tool.handler({ number: 5 }));
    expect(result.number).toBe(5);
  });

  it("returns error when number missing", async () => {
    const tool = createGithubGetIssueTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });
});

// ── githubCreatePR ────────────────────────────────────────────────────────────

describe("createGithubCreatePRTool", () => {
  it("creates PR and returns url + number", async () => {
    const data = { url: "https://github.com/org/repo/pull/7", number: 7 };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(data)));
    const tool = createGithubCreatePRTool(ws);
    const result = parse(await tool.handler({ title: "My PR" }));
    expect(result.url).toContain("pull/7");
    expect(result.number).toBe(7);
  });

  it("throws when title missing (requireString)", async () => {
    const tool = createGithubCreatePRTool(ws);
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("passes draft/base/body args", async () => {
    mockExecSafe.mockResolvedValue(ok(JSON.stringify({ url: "u", number: 1 })));
    const tool = createGithubCreatePRTool(ws);
    await tool.handler({
      title: "T",
      draft: true,
      base: "develop",
      body: "desc",
    });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--draft");
    expect(args).toContain("--base");
    expect(args).toContain("develop");
  });

  it("returns error on not-authed", async () => {
    mockExecSafe.mockResolvedValue(fail("HTTP 401"));
    const tool = createGithubCreatePRTool(ws);
    const result = await tool.handler({ title: "T" });
    expect(result.isError).toBe(true);
  });
});

// ── githubListPRs ─────────────────────────────────────────────────────────────

describe("createGithubListPRsTool", () => {
  it("returns PR list on success", async () => {
    const prs = [{ number: 3, title: "Fix bug", state: "open" }];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(prs)));
    const tool = createGithubListPRsTool(ws);
    const result = parse(await tool.handler({}));
    expect(result.prs).toHaveLength(1);
  });

  it("returns error on JSON parse failure", async () => {
    mockExecSafe.mockResolvedValue(ok("bad-json"));
    const tool = createGithubListPRsTool(ws);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });
});

// ── githubGetPR ───────────────────────────────────────────────────────────────

describe("createGithubViewPRTool", () => {
  it("returns PR detail on success", async () => {
    const pr = {
      number: 3,
      title: "Fix",
      state: "open",
      body: "",
      author: {},
      reviews: [],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(pr)));
    const tool = createGithubViewPRTool(ws);
    const result = parse(await tool.handler({ number: 3 }));
    expect(result.number).toBe(3);
  });

  it("returns current branch PR when number omitted", async () => {
    const pr = { number: 10, title: "Current", state: "open" };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(pr)));
    const tool = createGithubViewPRTool(ws);
    const result = parse(await tool.handler({}));
    expect(result.number).toBe(10);
  });

  it("returns error on not-found", async () => {
    mockExecSafe.mockResolvedValue(fail("Could not resolve to a PullRequest"));
    const tool = createGithubViewPRTool(ws);
    const result = await tool.handler({ number: 999 });
    expect(result.isError).toBe(true);
  });
});
