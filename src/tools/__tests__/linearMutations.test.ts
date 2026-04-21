import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/linear.js", () => ({
  loadTokens: vi.fn(),
  updateIssue: vi.fn(),
  addComment: vi.fn(),
}));

import {
  addComment,
  loadTokens,
  updateIssue,
} from "../../connectors/linear.js";
import { createAddLinearCommentTool } from "../addLinearComment.js";
import { createUpdateLinearIssueTool } from "../updateLinearIssue.js";

const mockLoadTokens = vi.mocked(loadTokens);
const mockUpdateIssue = vi.mocked(updateIssue);
const mockAddComment = vi.mocked(addComment);

const MOCK_TOKENS = {
  api_key: "lin_test",
  connected_at: "2026-04-20T00:00:00Z",
};

const MOCK_ISSUE = {
  id: "uuid-123",
  identifier: "ENG-42",
  title: "Fix login bug",
  url: "https://linear.app/org/issue/ENG-42",
  state: { name: "Done" },
};

const MOCK_COMMENT = {
  id: "comment-1",
  body: "Fixed in PR #7",
  url: "https://linear.app/org/issue/ENG-42#comment-1",
};

function structured(r: {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
}) {
  return (r.structuredContent ??
    JSON.parse(r.content[0]?.text ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

// ── updateLinearIssue ─────────────────────────────────────────────────────────

describe("createUpdateLinearIssueTool", () => {
  it("updates issue and returns result on success", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockUpdateIssue.mockResolvedValue(MOCK_ISSUE);

    const tool = createUpdateLinearIssueTool();
    const result = structured(
      await tool.handler({ id: "ENG-42", state: "Done" }),
    );

    expect(result.identifier).toBe("ENG-42");
    expect(result.state).toBe("Done");
    expect(result.linearConnected).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("passes all optional fields through to updateIssue", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockUpdateIssue.mockResolvedValue(MOCK_ISSUE);

    const tool = createUpdateLinearIssueTool();
    await tool.handler({
      id: "ENG-42",
      title: "New title",
      description: "Updated desc",
      priority: 1,
      state: "In Progress",
      assignee: "alice@example.com",
      labelNames: ["bug", "urgent"],
    });

    const args = mockUpdateIssue.mock.calls[0]?.[0];
    expect(args?.title).toBe("New title");
    expect(args?.description).toBe("Updated desc");
    expect(args?.priority).toBe(1);
    expect(args?.state).toBe("In Progress");
    expect(args?.assignee).toBe("alice@example.com");
    expect(args?.labels).toEqual(["bug", "urgent"]);
  });

  it("omits undefined optional fields", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockUpdateIssue.mockResolvedValue(MOCK_ISSUE);

    const tool = createUpdateLinearIssueTool();
    await tool.handler({ id: "ENG-42" });

    const args = mockUpdateIssue.mock.calls[0]?.[0];
    expect(args?.title).toBeUndefined();
    expect(args?.state).toBeUndefined();
    expect(args?.labels).toBeUndefined();
  });

  it("returns linearConnected: false when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);

    const tool = createUpdateLinearIssueTool();
    const result = structured(await tool.handler({ id: "ENG-42" }));

    expect(result.linearConnected).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("returns linearConnected: true with error on other failures", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockUpdateIssue.mockRejectedValue(new Error("Issue not found"));

    const tool = createUpdateLinearIssueTool();
    const result = structured(await tool.handler({ id: "ENG-999" }));

    expect(result.linearConnected).toBe(true);
    expect(result.error).toBe("Issue not found");
  });

  it("returns linearConnected: false on not-connected error from updateIssue", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockUpdateIssue.mockRejectedValue(
      new Error(
        "Linear not connected. GET /connections/linear/authorize first.",
      ),
    );

    const tool = createUpdateLinearIssueTool();
    const result = structured(await tool.handler({ id: "ENG-42" }));

    expect(result.linearConnected).toBe(false);
  });

  it("throws when id missing", async () => {
    const tool = createUpdateLinearIssueTool();
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("has correct schema name and required fields", () => {
    const tool = createUpdateLinearIssueTool();
    expect(tool.schema.name).toBe("updateLinearIssue");
    expect(tool.schema.inputSchema.required).toContain("id");
    expect(tool.schema.outputSchema.required).toContain("linearConnected");
  });
});

// ── addLinearComment ──────────────────────────────────────────────────────────

describe("createAddLinearCommentTool", () => {
  it("posts comment and returns result on success", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockAddComment.mockResolvedValue(MOCK_COMMENT);

    const tool = createAddLinearCommentTool();
    const result = structured(
      await tool.handler({ id: "ENG-42", body: "Fixed in PR #7" }),
    );

    expect(result.id).toBe("comment-1");
    expect(result.body).toBe("Fixed in PR #7");
    expect(result.url).toBe("https://linear.app/org/issue/ENG-42#comment-1");
    expect(result.linearConnected).toBe(true);
  });

  it("passes id and body to addComment", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockAddComment.mockResolvedValue(MOCK_COMMENT);

    const tool = createAddLinearCommentTool();
    const signal = new AbortController().signal;
    await tool.handler({ id: "ENG-42", body: "Hello" }, signal);

    expect(mockAddComment).toHaveBeenCalledWith("ENG-42", "Hello", signal);
  });

  it("returns linearConnected: false when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);

    const tool = createAddLinearCommentTool();
    const result = structured(await tool.handler({ id: "ENG-42", body: "Hi" }));

    expect(result.linearConnected).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("returns linearConnected: true with error on API failure", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockAddComment.mockRejectedValue(new Error("Comment failed"));

    const tool = createAddLinearCommentTool();
    const result = structured(await tool.handler({ id: "ENG-42", body: "Hi" }));

    expect(result.linearConnected).toBe(true);
    expect(result.error).toBe("Comment failed");
  });

  it("handles missing url in comment response", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockAddComment.mockResolvedValue({ id: "c1", body: "text" });

    const tool = createAddLinearCommentTool();
    const result = structured(
      await tool.handler({ id: "ENG-42", body: "text" }),
    );

    expect(result.url).toBe("");
  });

  it("throws when id or body missing", async () => {
    const tool = createAddLinearCommentTool();
    await expect(tool.handler({ id: "ENG-42" })).rejects.toThrow();
    await expect(tool.handler({ body: "hi" })).rejects.toThrow();
  });

  it("has correct schema name and required fields", () => {
    const tool = createAddLinearCommentTool();
    expect(tool.schema.name).toBe("addLinearComment");
    expect(tool.schema.inputSchema.required).toContain("id");
    expect(tool.schema.inputSchema.required).toContain("body");
    expect(tool.schema.outputSchema.required).toContain("linearConnected");
  });
});
