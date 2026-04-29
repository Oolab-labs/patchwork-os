import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import * as fs from "node:fs";
import {
  addComment,
  getStatus,
  handleLinearDisconnect,
  handleLinearTest,
  loadTokens,
} from "../linear.js";
import { McpClient } from "../mcpClient.js";

const MOCK_TOKEN_FILE = {
  vendor: "linear",
  client_id: "client-abc",
  access_token: "acc-xyz",
  connected_at: "2026-04-20T00:00:00.000Z",
  profile: { workspace: "acme" },
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LINEAR_API_KEY;
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
});

describe("loadTokens", () => {
  it("returns null when no file and no env var", () => {
    expect(loadTokens()).toBeNull();
  });

  it("maps file access_token into api_key shape", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("acc-xyz");
    expect(tokens?.workspace).toBe("acme");
  });

  it("returns env-var token without file", () => {
    process.env.LINEAR_API_KEY = "lin_api_from_env";
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("lin_api_from_env");
  });
});

describe("getStatus", () => {
  it("returns disconnected when no tokens", () => {
    const s = getStatus();
    expect(s.status).toBe("disconnected");
    expect(s.id).toBe("linear");
  });

  it("returns connected when token file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBe("acme");
  });
});

describe("handleLinearTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleLinearTest();
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { ok: boolean; error: string };
    expect(body.error).toContain("not connected");
  });
});

describe("handleLinearDisconnect", () => {
  it("returns ok even when no file", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handleLinearDisconnect();
    expect(result.status).toBe(200);
  });
});

describe("addComment", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "lin_api_test";
  });

  it("calls create_comment MCP tool with correct args and unwraps comment", async () => {
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: "cmt-1",
              body: "hello",
              url: "https://linear.app/c/cmt-1",
            }),
          },
        ],
      } as never);

    const result = await addComment("ENG-42", "hello");
    expect(result.id).toBe("cmt-1");
    expect(result.body).toBe("hello");
    expect(callTool).toHaveBeenCalledWith(
      "create_comment",
      { issueId: "ENG-42", body: "hello" },
      expect.any(Object),
    );
    callTool.mockRestore();
  });

  it("unwraps `comment` envelope when MCP returns wrapped shape", async () => {
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              comment: { id: "cmt-2", body: "nudge" },
            }),
          },
        ],
      } as never);
    const result = await addComment("ENG-7", "nudge");
    expect(result.id).toBe("cmt-2");
    expect(result.body).toBe("nudge");
    callTool.mockRestore();
  });

  it("rejects empty issueId", async () => {
    await expect(addComment("", "hi")).rejects.toThrow(/issueId/i);
    await expect(addComment("   ", "hi")).rejects.toThrow(/issueId/i);
  });

  it("rejects empty body", async () => {
    await expect(addComment("ENG-42", "")).rejects.toThrow(/body/i);
    await expect(addComment("ENG-42", "   ")).rejects.toThrow(/body/i);
  });

  it("rejects malformed issue ref before calling MCP", async () => {
    const callTool = vi.spyOn(McpClient.prototype, "callTool");
    await expect(addComment("not-an-issue", "hi")).rejects.toThrow(
      /Cannot parse Linear issue ID/,
    );
    expect(callTool).not.toHaveBeenCalled();
    callTool.mockRestore();
  });

  it("propagates MCP error (e.g. issue not found)", async () => {
    const callTool = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockRejectedValue(
        new Error("tools/call create_comment: Entity not found: Issue"),
      );
    await expect(addComment("ENG-99999", "hi")).rejects.toThrow(
      /Entity not found/,
    );
    callTool.mockRestore();
  });
});
