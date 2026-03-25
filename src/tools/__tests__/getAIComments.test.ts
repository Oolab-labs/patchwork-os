import { describe, expect, it, vi } from "vitest";
import type { AIComment } from "../../extensionClient.js";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetAICommentsTool } from "../getAIComments.js";

function makeComment(overrides: Partial<AIComment> = {}): AIComment {
  return {
    file: "/workspace/src/foo.ts",
    line: 10,
    comment: "fix the null check",
    syntax: "//",
    fullLine: "// AI: fix: fix the null check",
    severity: "fix",
    ...overrides,
  };
}

function makeClient(
  overrides: Partial<{
    connected: boolean;
    comments: AIComment[] | null;
    throws: unknown;
  }> = {},
) {
  const { connected = true, comments = [], throws } = overrides;
  const latestAIComments = new Map<string, AIComment[]>();
  return {
    isConnected: () => connected,
    latestAIComments,
    getAIComments: throws
      ? vi.fn().mockRejectedValue(throws)
      : vi.fn().mockResolvedValue(comments),
  };
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("getAIComments — extension not connected", () => {
  it("returns error when extension is disconnected", async () => {
    const client = makeClient({ connected: false });
    const tool = createGetAICommentsTool(client as never);
    const result = await tool.handler();
    expect(result.content[0]?.text).toContain("Extension not connected");
  });
});

describe("getAIComments — timeout", () => {
  it("returns error on ExtensionTimeoutError", async () => {
    const client = makeClient({ throws: new ExtensionTimeoutError("timeout") });
    const tool = createGetAICommentsTool(client as never);
    const result = await tool.handler();
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("re-throws non-timeout errors", async () => {
    const client = makeClient({ throws: new Error("boom") });
    const tool = createGetAICommentsTool(client as never);
    await expect(tool.handler()).rejects.toThrow("boom");
  });
});

describe("getAIComments — extension returns null", () => {
  it("returns error when extension disconnects mid-call", async () => {
    const client = makeClient({ comments: null });
    const tool = createGetAICommentsTool(client as never);
    const result = await tool.handler();
    expect(result.content[0]?.text).toContain("disconnected");
  });
});

describe("getAIComments — empty result", () => {
  it("returns count 0 and helpful message", async () => {
    const client = makeClient({ comments: [] });
    const tool = createGetAICommentsTool(client as never);
    const result = parse(await tool.handler());
    expect(result.count).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.message).toContain("No AI comments");
  });

  it("does not populate latestAIComments cache", async () => {
    const client = makeClient({ comments: [] });
    const tool = createGetAICommentsTool(client as never);
    await tool.handler();
    expect(client.latestAIComments.size).toBe(0);
  });
});

describe("getAIComments — with comments", () => {
  it("returns comments and count", async () => {
    const c1 = makeComment({ severity: "fix" });
    const c2 = makeComment({
      file: "/workspace/src/bar.ts",
      line: 5,
      severity: "todo",
    });
    const client = makeClient({ comments: [c1, c2] });
    const tool = createGetAICommentsTool(client as never);
    const result = parse(await tool.handler());
    expect(result.count).toBe(2);
    expect(result.comments).toHaveLength(2);
    expect(result.summary).toEqual({ fix: 1, todo: 1 });
    expect(result.tip).toContain("createGithubIssueFromAIComment");
  });

  it("populates latestAIComments cache grouped by file", async () => {
    const c1 = makeComment({ file: "/workspace/src/foo.ts", line: 1 });
    const c2 = makeComment({ file: "/workspace/src/foo.ts", line: 2 });
    const c3 = makeComment({ file: "/workspace/src/bar.ts", line: 3 });
    const client = makeClient({ comments: [c1, c2, c3] });
    const tool = createGetAICommentsTool(client as never);
    await tool.handler();
    expect(client.latestAIComments.get("/workspace/src/foo.ts")).toHaveLength(
      2,
    );
    expect(client.latestAIComments.get("/workspace/src/bar.ts")).toHaveLength(
      1,
    );
  });

  it("clears stale cache before repopulating", async () => {
    const stale = makeComment({ file: "/workspace/src/old.ts" });
    const client = makeClient({ comments: [makeComment()] });
    client.latestAIComments.set("/workspace/src/old.ts", [stale]);
    const tool = createGetAICommentsTool(client as never);
    await tool.handler();
    expect(client.latestAIComments.has("/workspace/src/old.ts")).toBe(false);
  });
});
