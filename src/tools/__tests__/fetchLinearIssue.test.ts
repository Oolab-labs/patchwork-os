import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/linear.js", () => ({
  fetchIssue: vi.fn(),
}));

import { fetchIssue } from "../../connectors/linear.js";
import { createFetchLinearIssueTool } from "../fetchLinearIssue.js";

const MOCK_ISSUE = {
  id: "abc123",
  identifier: "LIN-42",
  title: "Fix null pointer in auth flow",
  description: "Crashes on login when session is null.",
  state: { name: "In Progress", type: "started" },
  assignee: { name: "Waweru Karago", email: "kwkarago@gmail.com" },
  priority: 2,
  priorityLabel: "High",
  url: "https://linear.app/patchwork-os/issue/LIN-42",
  team: { name: "Patchwork", key: "LIN" },
  labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(fetchIssue).mockReset();
});

describe("fetchLinearIssue tool", () => {
  it("returns structured issue data on success", async () => {
    vi.mocked(fetchIssue).mockResolvedValueOnce(MOCK_ISSUE);
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-42" });
    const data = result.structuredContent as Record<string, unknown>;

    expect(data.identifier).toBe("LIN-42");
    expect(data.title).toBe("Fix null pointer in auth flow");
    expect(data.labels).toEqual(["bug", "auth"]);
    expect(data.linearConnected).toBe(true);
    expect(data.state).toEqual({ name: "In Progress", type: "started" });
  });

  it("flattens labels from nodes array", async () => {
    vi.mocked(fetchIssue).mockResolvedValueOnce(MOCK_ISSUE);
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-42" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.labels).toEqual(["bug", "auth"]);
  });

  it("returns null description when absent", async () => {
    vi.mocked(fetchIssue).mockResolvedValueOnce({
      ...MOCK_ISSUE,
      description: undefined,
    });
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-42" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.description).toBeNull();
  });

  it("returns null assignee when absent", async () => {
    vi.mocked(fetchIssue).mockResolvedValueOnce({
      ...MOCK_ISSUE,
      assignee: undefined,
    });
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-42" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.assignee).toBeNull();
  });

  it("returns error payload when not connected", async () => {
    vi.mocked(fetchIssue).mockRejectedValueOnce(
      new Error(
        "Linear not connected. POST /connections/linear/connect first.",
      ),
    );
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-42" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.linearConnected).toBe(false);
    expect(data.error).toContain("not connected");
  });

  it("sets linearConnected true on non-auth errors", async () => {
    vi.mocked(fetchIssue).mockRejectedValueOnce(new Error("issue not found"));
    const tool = createFetchLinearIssueTool();
    const result = await tool.handler({ issueId: "LIN-99" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.linearConnected).toBe(true);
    expect(data.error).toBe("issue not found");
  });

  it("passes signal to fetchIssue", async () => {
    vi.mocked(fetchIssue).mockResolvedValueOnce(MOCK_ISSUE);
    const tool = createFetchLinearIssueTool();
    const signal = AbortSignal.timeout(5000);
    await tool.handler({ issueId: "LIN-42" }, signal);
    expect(vi.mocked(fetchIssue)).toHaveBeenCalledWith("LIN-42", signal);
  });
});
