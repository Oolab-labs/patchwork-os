import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/slack.js", () => ({
  loadTokens: vi.fn(),
  postMessage: vi.fn(),
  listChannels: vi.fn(),
  getProfile: vi.fn(),
}));

import {
  getProfile,
  listChannels,
  loadTokens,
  postMessage,
} from "../../connectors/slack.js";
import { createFetchSlackProfileTool } from "../fetchSlackProfile.js";
import { createSlackListChannelsTool } from "../slackListChannels.js";
import { createSlackPostMessageTool } from "../slackPostMessage.js";

const mockLoadTokens = vi.mocked(loadTokens);
const mockPostMessage = vi.mocked(postMessage);
const mockListChannels = vi.mocked(listChannels);
const mockGetProfile = vi.mocked(getProfile);

const MOCK_TOKENS = {
  access_token: "xoxb-test",
  team_id: "T123",
  team_name: "Acme",
  bot_user_id: "U456",
  connected_at: "2026-04-20T00:00:00Z",
};

function structured(r: {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
}) {
  return (r.structuredContent ??
    JSON.parse(r.content[0]?.text ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

// ── slackPostMessage ──────────────────────────────────────────────────────────

describe("createSlackPostMessageTool", () => {
  it("posts message and returns ts and channel", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockPostMessage.mockResolvedValue({
      ts: "1234567890.000100",
      channel: "C123",
    });

    const tool = createSlackPostMessageTool();
    const result = structured(
      await tool.handler({ channel: "general", text: "Hello!" }),
    );

    expect(result.ts).toBe("1234567890.000100");
    expect(result.channel).toBe("C123");
    expect(result.slackConnected).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("passes channel, text, and threadTs to postMessage", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockPostMessage.mockResolvedValue({ ts: "ts1", channel: "C123" });

    const tool = createSlackPostMessageTool();
    const signal = new AbortController().signal;
    await tool.handler(
      { channel: "C123", text: "Reply", threadTs: "1234.000" },
      signal,
    );

    expect(mockPostMessage).toHaveBeenCalledWith(
      "C123",
      "Reply",
      "1234.000",
      undefined,
      signal,
    );
  });

  it("passes undefined threadTs when not provided", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockPostMessage.mockResolvedValue({ ts: "ts1", channel: "C123" });

    const tool = createSlackPostMessageTool();
    await tool.handler({ channel: "general", text: "Hi" });

    expect(mockPostMessage).toHaveBeenCalledWith(
      "general",
      "Hi",
      undefined,
      undefined,
      undefined,
    );
  });

  it("returns slackConnected: false when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);

    const tool = createSlackPostMessageTool();
    const result = structured(
      await tool.handler({ channel: "general", text: "Hi" }),
    );

    expect(result.slackConnected).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("returns slackConnected: true with error on API failure", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockPostMessage.mockRejectedValue(new Error("channel_not_found"));

    const tool = createSlackPostMessageTool();
    const result = structured(
      await tool.handler({ channel: "unknown", text: "Hi" }),
    );

    expect(result.slackConnected).toBe(true);
    expect(result.error).toBe("channel_not_found");
  });

  it("returns slackConnected: false on not-connected error from postMessage", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockPostMessage.mockRejectedValue(
      new Error("Slack not connected. GET /connections/slack/authorize first."),
    );

    const tool = createSlackPostMessageTool();
    const result = structured(
      await tool.handler({ channel: "general", text: "Hi" }),
    );

    expect(result.slackConnected).toBe(false);
  });

  it("throws when channel or text missing", async () => {
    const tool = createSlackPostMessageTool();
    await expect(tool.handler({ text: "Hi" })).rejects.toThrow();
    await expect(tool.handler({ channel: "general" })).rejects.toThrow();
  });

  it("has correct schema name and required fields", () => {
    const tool = createSlackPostMessageTool();
    expect(tool.schema.name).toBe("slackPostMessage");
    expect(tool.schema.inputSchema.required).toContain("channel");
    expect(tool.schema.inputSchema.required).toContain("text");
    expect(tool.schema.outputSchema.required).toContain("slackConnected");
  });
});

// ── slackListChannels ─────────────────────────────────────────────────────────

describe("createSlackListChannelsTool", () => {
  it("returns channel list on success", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockListChannels.mockResolvedValue([
      {
        id: "C001",
        name: "general",
        isMember: true,
        isPrivate: false,
        numMembers: 42,
      },
      { id: "C002", name: "random", isMember: true, isPrivate: false },
    ]);

    const tool = createSlackListChannelsTool();
    const result = structured(await tool.handler({}));
    const channels = result.channels as Array<Record<string, unknown>>;

    expect(channels).toHaveLength(2);
    expect(channels[0]?.name).toBe("general");
    expect(channels[0]?.numMembers).toBe(42);
    expect(result.slackConnected).toBe(true);
  });

  it("passes limit to listChannels", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockListChannels.mockResolvedValue([]);

    const tool = createSlackListChannelsTool();
    await tool.handler({ limit: 50 });

    expect(mockListChannels).toHaveBeenCalledWith(50, undefined);
  });

  it("returns slackConnected: false when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);

    const tool = createSlackListChannelsTool();
    const result = structured(await tool.handler({}));

    expect(result.slackConnected).toBe(false);
    expect(result.channels).toEqual([]);
    expect(mockListChannels).not.toHaveBeenCalled();
  });

  it("returns slackConnected: true with error on API failure", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockListChannels.mockRejectedValue(new Error("missing_scope"));

    const tool = createSlackListChannelsTool();
    const result = structured(await tool.handler({}));

    expect(result.slackConnected).toBe(true);
    expect(result.error).toBe("missing_scope");
  });

  it("has correct schema name", () => {
    const tool = createSlackListChannelsTool();
    expect(tool.schema.name).toBe("slackListChannels");
    expect(tool.schema.outputSchema.required).toContain("slackConnected");
  });
});

// ── fetchSlackProfile ─────────────────────────────────────────────────────────

describe("createFetchSlackProfileTool", () => {
  it("returns profile when connected", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockGetProfile.mockReturnValue({
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U456",
    });

    const tool = createFetchSlackProfileTool();
    const result = structured(await tool.handler({}));

    expect(result.teamId).toBe("T123");
    expect(result.teamName).toBe("Acme");
    expect(result.botUserId).toBe("U456");
    expect(result.slackConnected).toBe(true);
  });

  it("returns slackConnected: false when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);

    const tool = createFetchSlackProfileTool();
    const result = structured(await tool.handler({}));

    expect(result.slackConnected).toBe(false);
    expect(result.error).toMatch(/not connected/i);
  });

  it("returns slackConnected: false when getProfile returns null", async () => {
    mockLoadTokens.mockReturnValue(MOCK_TOKENS);
    mockGetProfile.mockReturnValue(null);

    const tool = createFetchSlackProfileTool();
    const result = structured(await tool.handler({}));

    expect(result.slackConnected).toBe(false);
  });

  it("has correct schema name", () => {
    const tool = createFetchSlackProfileTool();
    expect(tool.schema.name).toBe("fetchSlackProfile");
    expect(tool.schema.outputSchema.required).toContain("slackConnected");
  });
});
