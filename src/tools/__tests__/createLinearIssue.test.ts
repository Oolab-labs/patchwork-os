import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/linear.js", () => ({
  loadTokens: vi.fn(),
  listTeams: vi.fn(),
  listLabels: vi.fn(),
  createIssue: vi.fn(),
}));

import {
  createIssue,
  listLabels,
  listTeams,
  loadTokens,
} from "../../connectors/linear.js";
import { createLinearIssueTool } from "../createLinearIssue.js";

const MOCK_TOKENS = {
  api_key: "lin_test_key",
  connected_at: "2026-04-20T00:00:00Z",
};

const MOCK_TEAMS = [{ id: "team-1", key: "ENG", name: "Engineering" }];

const MOCK_CREATED = {
  id: "issue-abc",
  identifier: "ENG-101",
  title: "Fix login bug",
  url: "https://linear.app/org/issue/ENG-101",
  state: { name: "Backlog" },
};

beforeEach(() => {
  vi.mocked(loadTokens).mockReset();
  vi.mocked(listTeams).mockReset();
  vi.mocked(listLabels).mockReset();
  vi.mocked(createIssue).mockReset();
});

describe("createLinearIssue tool", () => {
  it("returns created issue on success", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    const result = await tool.handler({ title: "Fix login bug" });
    const data = result.structuredContent as Record<string, unknown>;

    expect(data.identifier).toBe("ENG-101");
    expect(data.url).toBe("https://linear.app/org/issue/ENG-101");
    expect(data.linearConnected).toBe(true);
    expect(data.team).toBe("Engineering (ENG)");
  });

  it("uses first team when teamKey not specified", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue([
      { id: "team-1", key: "ENG", name: "Engineering" },
      { id: "team-2", key: "OPS", name: "Operations" },
    ]);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    await tool.handler({ title: "Test" });

    const args = vi.mocked(createIssue).mock.calls[0]?.[0];
    expect(args?.team).toBe("Engineering");
  });

  it("resolves teamKey case-insensitively", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    const result = await tool.handler({ title: "Test", teamKey: "eng" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.identifier).toBe("ENG-101");
  });

  it("errors when teamKey not found", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);

    const tool = createLinearIssueTool();
    const result = await tool.handler({ title: "Test", teamKey: "NOPE" });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.error).toContain("'NOPE' not found");
    expect(data.linearConnected).toBe(true);
  });

  it("passes priority to create input", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    await tool.handler({ title: "Urgent fix", priority: 1 });

    const args = vi.mocked(createIssue).mock.calls[0]?.[0];
    expect(args?.priority).toBe(1);
  });

  it("resolves label names to IDs", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);
    vi.mocked(listLabels).mockResolvedValue([
      { id: "label-bug", name: "bug" },
      { id: "label-fe", name: "frontend" },
    ]);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    await tool.handler({ title: "Bug fix", labelNames: ["bug"] });

    const args = vi.mocked(createIssue).mock.calls[0]?.[0];
    expect(args?.labels).toEqual(["bug"]);
  });

  it("returns notConnected when tokens absent", async () => {
    vi.mocked(loadTokens).mockReturnValue(null);

    const tool = createLinearIssueTool();
    const result = await tool.handler({ title: "Won't work" });
    const data = result.structuredContent as Record<string, unknown>;

    expect(data.linearConnected).toBe(false);
    expect(data.error).toContain("not connected");
    expect(vi.mocked(createIssue)).not.toHaveBeenCalled();
  });

  it("skips label resolution when no labelNames provided", async () => {
    vi.mocked(loadTokens).mockReturnValue(MOCK_TOKENS);
    vi.mocked(listTeams).mockResolvedValue(MOCK_TEAMS);
    vi.mocked(createIssue).mockResolvedValue(MOCK_CREATED);

    const tool = createLinearIssueTool();
    await tool.handler({ title: "No labels" });

    expect(vi.mocked(listLabels)).not.toHaveBeenCalled();
  });
});
