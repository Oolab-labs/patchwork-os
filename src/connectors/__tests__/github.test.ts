import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as fs from "node:fs";
import {
  createIssue,
  fetchGitHubIssue,
  fetchGitHubPR,
  getStatus,
  handleGithubAuthorize,
  handleGithubCallback,
  handleGithubDisconnect,
  handleGithubTest,
  listCommits,
  listIssues,
  listPRs,
} from "../github.js";

import { McpClient } from "../mcpClient.js";

const MOCK_TOKEN_FILE = {
  vendor: "github",
  client_id: "gh-client",
  client_secret: "gh-secret",
  access_token: "ghp_test",
  connected_at: "2026-04-30T00:00:00.000Z",
  profile: { login: "octocat" },
};

function mockConnected(file: object = MOCK_TOKEN_FILE) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(file));
}

function mcpJsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
  mockFetch.mockReset();
  process.env.PATCHWORK_GITHUB_CLIENT_ID = "test-client-id";
  process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  delete process.env.PATCHWORK_GITHUB_CLIENT_ID;
  delete process.env.PATCHWORK_GITHUB_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("getStatus", () => {
  it("returns disconnected when no token file", () => {
    expect(getStatus()).toEqual({ connected: false });
  });

  it("returns connected with user login from profile", () => {
    mockConnected();
    expect(getStatus()).toEqual({ connected: true, user: "octocat" });
  });

  it("returns connected with undefined user when profile absent", () => {
    mockConnected({ ...MOCK_TOKEN_FILE, profile: undefined });
    const s = getStatus();
    expect(s.connected).toBe(true);
    expect(s.user).toBeUndefined();
  });
});

describe("listIssues", () => {
  it("throws when not connected (no MCP call)", async () => {
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    await expect(listIssues()).rejects.toThrow(/not connected/);
    expect(callTool).not.toHaveBeenCalled();
    callTool.mockRestore();
  });

  it("calls list_issues with parsed owner/repo and limit cap", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult([]));
    await listIssues({ repo: "acme/widget", limit: 999, assignee: "@me" });
    expect(callTool).toHaveBeenCalledWith(
      "list_issues",
      expect.objectContaining({
        state: "open",
        owner: "acme",
        repo: "widget",
        assignee: "@me",
        perPage: 50,
      }),
      expect.any(Object),
    );
    callTool.mockRestore();
  });

  it("forwards labels + non-default state, and omits both when unset", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult([]));
    await listIssues({
      repo: "acme/widget",
      labels: ["test-failure", "bug"],
      state: "all",
    });
    expect(callTool).toHaveBeenCalledWith(
      "list_issues",
      expect.objectContaining({
        state: "all",
        labels: ["test-failure", "bug"],
        owner: "acme",
        repo: "widget",
      }),
      expect.any(Object),
    );
    // No assignee filter requested → pass "*" so GitHub MCP sees all assignees.
    // (Omitting assignee causes the server to default to @me, hiding unassigned
    // issues — "*" is the explicit all-assignees sentinel per GitHub REST API.)
    expect(callTool.mock.calls[0]?.[1]).toHaveProperty("assignee", "*");
    callTool.mockClear();

    // Unset labels/state → state defaults to "open", no labels key, assignee="*".
    await listIssues({ repo: "acme/widget" });
    const args = callTool.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.state).toBe("open");
    expect(args).not.toHaveProperty("labels");
    expect(args.assignee).toBe("*");
    callTool.mockRestore();
  });

  it("coerces array-shape MCP response", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult([
        {
          number: 42,
          title: "bug",
          html_url: "https://github.com/acme/widget/issues/42",
          labels: [{ name: "P0" }, "bug"],
          updated_at: "2026-04-29T00:00:00Z",
          repository: { full_name: "acme/widget" },
        },
      ]),
    );
    const issues = await listIssues({ repo: "acme/widget" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      number: 42,
      title: "bug",
      repo: "acme/widget",
      url: "https://github.com/acme/widget/issues/42",
      labels: ["P0", "bug"],
    });
  });

  it("unwraps { items } envelope", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult({ items: [{ number: 7, title: "x" }] }),
    );
    const issues = await listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(7);
  });

  it("throws (does not silently empty) when MCP fails — PR #72 contract", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockRejectedValue(
      new Error("403 rate limit exceeded"),
    );
    await expect(listIssues()).rejects.toThrow(
      /list_issues failed.*rate limit/,
    );
  });
});

describe("listPRs", () => {
  it("throws when not connected", async () => {
    await expect(listPRs()).rejects.toThrow(/not connected/);
  });

  it("preserves draft + reviewDecision", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult([
        {
          number: 11,
          title: "wip",
          draft: true,
          review_decision: "REVIEW_REQUIRED",
          html_url: "https://github.com/acme/widget/pull/11",
          repository: { full_name: "acme/widget" },
        },
      ]),
    );
    const prs = await listPRs({ repo: "acme/widget", author: "@me" });
    expect(prs[0]).toMatchObject({
      number: 11,
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
    });
  });

  it("throws on MCP failure", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockRejectedValue(
      new Error("network down"),
    );
    await expect(listPRs()).rejects.toThrow(
      /list_pull_requests failed.*network down/,
    );
  });
});

describe("fetchGitHubIssue ref parsing", () => {
  it("throws when not connected", async () => {
    await expect(fetchGitHubIssue("acme/widget#1")).rejects.toThrow(
      /not connected/,
    );
  });

  it("parses URL ref and calls issue_read with owner/repo/number", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(
        mcpJsonResult({
          number: 42,
          title: "T",
          body: "B",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }],
          assignees: [{ login: "bob" }],
        }),
      );
    const issue = await fetchGitHubIssue(
      "https://github.com/acme/widget/issues/42",
    );
    expect(callTool).toHaveBeenCalledWith(
      "issue_read",
      { owner: "acme", repo: "widget", issue_number: 42, method: "get" },
      expect.any(Object),
    );
    expect(issue).toMatchObject({
      number: 42,
      title: "T",
      author: "alice",
      labels: ["bug"],
      assignees: ["bob"],
      repo: "acme/widget",
    });
  });

  it("parses owner/repo#N short form", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult({ number: 7, title: "x" }));
    await fetchGitHubIssue("acme/widget#7");
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      owner: "acme",
      repo: "widget",
      issue_number: 7,
    });
  });

  it("parses owner/repo/N short form", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult({ number: 9, title: "y" }));
    await fetchGitHubIssue("acme/widget/9");
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      owner: "acme",
      repo: "widget",
      issue_number: 9,
    });
  });

  it("throws on malformed ref before calling MCP", async () => {
    mockConnected();
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    await expect(fetchGitHubIssue("not a ref")).rejects.toThrow(
      /Cannot parse GitHub issue ref/,
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("fetchGitHubPR ref parsing", () => {
  it("throws when not connected", async () => {
    await expect(fetchGitHubPR("acme/widget#1")).rejects.toThrow(
      /not connected/,
    );
  });

  it("parses /pull/ URL and surfaces draft + branches", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult({
        number: 100,
        title: "Big PR",
        draft: true,
        review_decision: "APPROVED",
        head: { ref: "feat/x" },
        base: { ref: "main" },
        additions: 50,
        deletions: 10,
      }),
    );
    const pr = await fetchGitHubPR("https://github.com/acme/widget/pull/100");
    expect(pr).toMatchObject({
      number: 100,
      title: "Big PR",
      isDraft: true,
      reviewDecision: "APPROVED",
      headBranch: "feat/x",
      baseBranch: "main",
      additions: 50,
      deletions: 10,
    });
  });

  it("rejects malformed PR ref", async () => {
    mockConnected();
    await expect(fetchGitHubPR("garbage")).rejects.toThrow(
      /Cannot parse GitHub PR ref/,
    );
  });
});

describe("handleGithubAuthorize", () => {
  it("returns 400 when client id env var unset", async () => {
    delete process.env.PATCHWORK_GITHUB_CLIENT_ID;
    const result = await handleGithubAuthorize();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/PATCHWORK_GITHUB_CLIENT_ID/),
    });
  });

  it("returns 302 redirect to github authorize URL", async () => {
    const result = await handleGithubAuthorize();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain("github.com/login/oauth/authorize");
    expect(result.redirect).toContain("client_id=test-client-id");
    expect(result.redirect).toContain("scope=repo");
  });
});

describe("handleGithubCallback", () => {
  it("renders error page when error param present (HTML-escaped)", async () => {
    const result = await handleGithubCallback(
      null,
      null,
      "<script>alert(1)</script>",
    );
    expect(result.status).toBe(400);
    expect(result.contentType).toBe("text/html");
    expect(result.body).not.toContain("<script>alert(1)</script>");
    expect(result.body).toContain("&lt;script&gt;");
  });

  it("renders 400 when code or state missing", async () => {
    const result = await handleGithubCallback(null, "some-state", null);
    expect(result.status).toBe(400);
    expect(result.body).toContain("missing code or state");
  });

  it("renders 400 page when state is unknown / expired", async () => {
    const result = await handleGithubCallback("code", "unknown-state", null);
    expect(result.status).toBe(400);
    expect(result.body).toContain("invalid or expired state");
  });
});

describe("handleGithubTest", () => {
  it("returns ok:false when not connected", async () => {
    const result = await handleGithubTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      message: "Not connected",
    });
  });

  it("returns ok:true when MCP ping succeeds", async () => {
    mockConnected();
    const ping = vi
      .spyOn(McpClient.prototype, "ping")
      .mockResolvedValue(true as never);
    const result = await handleGithubTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      message: expect.stringContaining("octocat"),
    });
    ping.mockRestore();
  });

  it("returns ok:false with error message when MCP ping throws", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "ping").mockRejectedValue(
      new Error("upstream 502"),
    );
    const result = await handleGithubTest();
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      message: expect.stringContaining("upstream 502"),
    });
  });
});

describe("handleGithubDisconnect", () => {
  it("returns ok:true even when no token file", async () => {
    const result = await handleGithubDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });
});

describe("listCommits", () => {
  it("throws when not connected", async () => {
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    await expect(listCommits({ repo: "acme/widget" })).rejects.toThrow(
      /not connected/,
    );
    expect(callTool).not.toHaveBeenCalled();
    callTool.mockRestore();
  });

  it("throws when repo is not owner/repo format", async () => {
    mockConnected();
    await expect(listCommits({ repo: "widget" })).rejects.toThrow(
      /owner\/repo/,
    );
  });

  it("calls list_commits with owner/repo and perPage cap", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult([]));
    await listCommits({ repo: "acme/widget", limit: 999 });
    expect(callTool).toHaveBeenCalledWith(
      "list_commits",
      expect.objectContaining({ owner: "acme", repo: "widget", perPage: 100 }),
      expect.any(Object),
    );
    callTool.mockRestore();
  });

  it("resolves @me author to connected login", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult([]));
    await listCommits({ repo: "acme/widget", author: "@me" });
    expect(callTool).toHaveBeenCalledWith(
      "list_commits",
      expect.objectContaining({ author: "octocat" }),
      expect.any(Object),
    );
    callTool.mockRestore();
  });

  it("passes since/until/sha when provided", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(mcpJsonResult([]));
    await listCommits({
      repo: "acme/widget",
      since: "2026-05-19T00:00:00Z",
      until: "2026-05-26T00:00:00Z",
      sha: "main",
    });
    expect(callTool).toHaveBeenCalledWith(
      "list_commits",
      expect.objectContaining({
        since: "2026-05-19T00:00:00Z",
        until: "2026-05-26T00:00:00Z",
        sha: "main",
      }),
      expect.any(Object),
    );
    callTool.mockRestore();
  });

  it("coerces raw MCP response to GitHubCommit shape", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult([
        {
          sha: "abc1234567890",
          commit: {
            message: "fix(auth): correct token refresh\n\nLonger description",
            author: { name: "Alice", date: "2026-05-20T10:00:00Z" },
          },
          author: { login: "alice" },
          html_url: "https://github.com/acme/widget/commit/abc1234567890",
        },
      ]),
    );
    const commits = await listCommits({ repo: "acme/widget" });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: "abc123456789",
      message: "fix(auth): correct token refresh",
      author: "alice",
      authoredAt: "2026-05-20T10:00:00Z",
      url: "https://github.com/acme/widget/commit/abc1234567890",
      repo: "acme/widget",
    });
  });

  it("unwraps { items } envelope", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult({
        items: [{ sha: "deadbeef1234", commit: { message: "chore: bump" } }],
      }),
    );
    const commits = await listCommits({ repo: "acme/widget" });
    expect(commits).toHaveLength(1);
  });

  it("throws on MCP failure — PR #72 contract", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockRejectedValue(
      new Error("401 token expired"),
    );
    await expect(listCommits({ repo: "acme/widget" })).rejects.toThrow(
      /list_commits failed.*401 token expired/,
    );
  });
});

describe("createIssue (WRITE)", () => {
  it("throws when not connected (no MCP call)", async () => {
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    await expect(
      createIssue({ repo: "acme/widget", title: "t" }),
    ).rejects.toThrow(/not connected/);
    expect(callTool).not.toHaveBeenCalled();
    callTool.mockRestore();
  });

  it("rejects a non 'owner/repo' repo before any MCP call (review #1029)", async () => {
    mockConnected();
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    // 3-segment must NOT silently truncate to owner/repo
    await expect(
      createIssue({ repo: "acme/widget/extra", title: "t" }),
    ).rejects.toThrow(/exact 'owner\/repo'/);
    await expect(createIssue({ repo: "widget", title: "t" })).rejects.toThrow(
      /exact 'owner\/repo'/,
    );
    expect(callTool).not.toHaveBeenCalled();
    callTool.mockRestore();
  });

  it("calls issue_write with owner/repo/title/body/labels/assignees and returns the issue", async () => {
    mockConnected();
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue(
        // issue_write returns { id, url } — not the old { number, html_url, title } shape.
        mcpJsonResult({
          id: "I_kwDOA1bvCc5abc123",
          url: "https://github.com/acme/widget/issues/42",
        }),
      );
    const issue = await createIssue({
      repo: "acme/widget",
      title: "Flaky test",
      body: "details",
      labels: ["bug"],
      assignees: ["octocat"],
    });
    expect(callTool).toHaveBeenCalledWith(
      "issue_write",
      expect.objectContaining({
        owner: "acme",
        repo: "widget",
        title: "Flaky test",
        body: "details",
        labels: ["bug"],
        assignees: ["octocat"],
      }),
      expect.any(Object),
    );
    expect(issue).toEqual({
      number: 42,
      url: "https://github.com/acme/widget/issues/42",
      title: "Flaky test",
    });
  });

  it("throws when the MCP response has no parseable issue URL (no fabricated success)", async () => {
    mockConnected();
    vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue(
      mcpJsonResult({ message: "ok but not an issue" }),
    );
    await expect(
      createIssue({ repo: "acme/widget", title: "t" }),
    ).rejects.toThrow(/no parseable issue URL/);
  });
});
