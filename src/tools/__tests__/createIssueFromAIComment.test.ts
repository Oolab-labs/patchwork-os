import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import type { AIComment } from "../../extensionClient.js";
import { createCreateIssueFromAICommentTool } from "../createIssueFromAIComment.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const ws = "/fake/workspace";

function makeResult(stdout: string, exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode, timedOut: false, durationMs: 10 };
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeComment(
  overrides: Partial<AIComment> = {},
): AIComment {
  return {
    file: `${ws}/src/index.ts`,
    line: 10,
    comment: "AI: TODO: refactor this loop",
    syntax: "//",
    fullLine: "// AI: TODO: refactor this loop",
    severity: "todo",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("createGithubIssueFromAIComment — cache miss", () => {
  it("returns error when cache is empty", async () => {
    const cache = new Map<string, AIComment[]>();
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = await tool.handler({
      file: `${ws}/src/index.ts`,
      line: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Run getAIComments first");
  });

  it("returns error when file is in cache but line does not match", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment({ line: 5 })]],
    ]);
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = await tool.handler({ file, line: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Run getAIComments first");
  });
});

describe("createGithubIssueFromAIComment — title derivation", () => {
  it("derives title from comment text, stripping AI: prefix", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment({ comment: "AI: fix the memory leak" })]],
    ]);
    mockExecSafe.mockResolvedValue(
      makeResult("https://github.com/org/repo/issues/42"),
    );
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = parse(await tool.handler({ file, line: 10 }));
    expect(result.title).toBe("fix the memory leak");
  });

  it("uses explicit title override when provided", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment()]],
    ]);
    mockExecSafe.mockResolvedValue(
      makeResult("https://github.com/org/repo/issues/7"),
    );
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = parse(
      await tool.handler({ file, line: 10, title: "Custom Issue Title" }),
    );
    expect(result.title).toBe("Custom Issue Title");
  });
});

describe("createGithubIssueFromAIComment — gh args", () => {
  it("passes labels and assignee to gh when provided", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment()]],
    ]);
    mockExecSafe.mockResolvedValue(
      makeResult("https://github.com/org/repo/issues/9"),
    );
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    await tool.handler({
      file,
      line: 10,
      labels: "bug,ai-comment",
      assignee: "octocat",
    });
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--label");
    expect(args).toContain("bug,ai-comment");
    expect(args).toContain("--assignee");
    expect(args).toContain("octocat");
  });
});

describe("createGithubIssueFromAIComment — error handling", () => {
  it("returns auth error when gh is not logged in", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment()]],
    ]);
    mockExecSafe.mockResolvedValue(
      makeResult("", 1, "not authenticated: run gh auth login"),
    );
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = await tool.handler({ file, line: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("gh auth login");
  });
});

describe("createGithubIssueFromAIComment — issue number parsing", () => {
  it("correctly parses issue number from returned URL", async () => {
    const file = `${ws}/src/index.ts`;
    const cache = new Map<string, AIComment[]>([
      [file, [makeComment()]],
    ]);
    mockExecSafe.mockResolvedValue(
      makeResult("https://github.com/org/repo/issues/123"),
    );
    const tool = createCreateIssueFromAICommentTool(ws, cache);
    const result = parse(await tool.handler({ file, line: 10 }));
    expect(result.number).toBe(123);
    expect(result.url).toBe("https://github.com/org/repo/issues/123");
    expect(result.commentFile).toBe(file);
    expect(result.commentLine).toBe(10);
    expect(result.severity).toBe("todo");
  });
});
